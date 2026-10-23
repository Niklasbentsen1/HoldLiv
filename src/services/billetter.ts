// Billetsalg med QR-kode til foreningens arrangementer, fx hjemmekampe og fester.
//
// Regler:
//   - Foreningens admin/kasserer opretter arrangementet og bestemmer selv prisen, antal pladser og hvornår salget lukker.
//     HoldLiv har ingen standardpriser. En prisændring gælder kun nye bestillinger; en bestilling gemmer sin pris.
//   - Alle kan købe uden login: navn og e-mail, antal billetter og betaling via foreningens egen Stripe-konto (testbetaling uden nøgle).
//     Køberen får et hemmeligt link (og en mail) med billetterne. Det eneste personhenførbare er køberens navn og e-mail.
//   - En bestilling holder pladserne i 35 minutter, mens der betales. Stripe-sessionen udløber efter 31 minutter, så en betaling
//     aldrig kommer efter, at pladserne er givet videre. Kapaciteten tæller betalte billetter og ikke-udløbne bestillinger.
//   - Hver billet har en hemmelig kode i en QR-kode (/billet/<kode>). Admin, kasserer og trænere i foreningen kan scanne den (login);
//     billetten kan kun bruges én gang, og to samtidige scanninger kan ikke begge slippe ind.
//   - Admin/kasserer kan refundere en bestilling; billetterne bliver så ugyldige. Aflyses arrangementet, lukker salget, ikke betalte
//     bestillinger annulleres, og betalte skal refunderes.
//   - Misbrugsværn på den åbne side: grænse pr. afsender-IP, pr. e-mail og et skjult felt, som robotter udfylder.
import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubs, events, ticketEvents, ticketOrders, tickets, teams } from "../db/schema";
import { ForbiddenError, assertCan, type AccessContext } from "../auth/permissions";
import type { PaymentProvider } from "../lib/payments";
import type { Mailer } from "../lib/mail";
import { kr } from "../lib/money";
import { logAudit } from "./audit";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Teknisk øvre grænse: 50.000 kr. pr. billet. */
export const MAX_TICKET_PRICE_ORE = 5_000_000;
export const MAX_TICKET_CAPACITY = 100_000;
export const MAX_TICKETS_PER_ORDER = 20;
export const HOLD_MINUTES = 35;
export const CHECKOUT_MINUTES = 31;
export const MAX_ORDERS_PER_IP_PER_HOUR = 10;
export const MAX_PENDING_PER_EMAIL = 3;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f-]{36}$/i;
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
/** En betaling, der ikke kan give billetter (annulleret, pladser givet videre, forkert beløb). Pengene skal tilbage til køberen. */
export class TicketPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketPaymentError";
  }
}

const newToken = () => randomBytes(24).toString("base64url");

export interface TicketEventInput {
  name: string;
  description?: string | null;
  location?: string | null;
  startsAt: Date;
  priceOre: number;
  capacity?: number | null;
  saleClosesAt?: Date | null;
  maxPerOrder?: number;
  eventId?: string | null;
}

function clean(input: TicketEventInput) {
  const name = input.name.trim();
  if (!name) throw new Error("Giv arrangementet et navn.");
  if (name.length > 120) throw new Error("Navnet må højst være på 120 tegn.");
  const description = input.description?.trim() || null;
  if (description && description.length > 2000) throw new Error("Beskrivelsen må højst være på 2.000 tegn.");
  const location = input.location?.trim() || null;
  if (location && location.length > 120) throw new Error("Stedet må højst være på 120 tegn.");
  if (!(input.startsAt instanceof Date) || Number.isNaN(input.startsAt.getTime())) throw new Error("Vælg start for arrangementet.");
  if (!Number.isInteger(input.priceOre) || input.priceOre < 0 || input.priceOre > MAX_TICKET_PRICE_ORE) throw new Error("Prisen skal være mellem 0 og 50.000 kr.");
  const capacity = input.capacity ?? null;
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_TICKET_CAPACITY)) throw new Error("Antal pladser skal være et helt tal fra 1 til 100.000.");
  const saleClosesAt = input.saleClosesAt ?? null;
  if (saleClosesAt && Number.isNaN(saleClosesAt.getTime())) throw new Error("Tidspunktet for salgets lukning kan ikke læses.");
  if (saleClosesAt && saleClosesAt > input.startsAt) throw new Error("Salget kan ikke lukke efter, at arrangementet er startet.");
  const maxPerOrder = input.maxPerOrder ?? 10;
  if (!Number.isInteger(maxPerOrder) || maxPerOrder < 1 || maxPerOrder > MAX_TICKETS_PER_ORDER) throw new Error(`Højst ${MAX_TICKETS_PER_ORDER} billetter pr. bestilling.`);
  return { name, description, location, startsAt: input.startsAt, priceOre: input.priceOre, capacity, saleClosesAt, maxPerOrder };
}

async function loadTicketEvent(db: Pick<Db, "select">, id: string) {
  if (!UUID.test(id)) throw new Error("Arrangementet findes ikke.");
  const [e] = await db.select().from(ticketEvents).where(eq(ticketEvents.id, id));
  if (!e) throw new Error("Arrangementet findes ikke.");
  return e;
}

/** Det kalenderen må knytte til: kun en aktivitet i samme forening. */
async function checkLinkedEvent(db: Db, clubId: string, eventId: string | null | undefined) {
  if (!eventId) return null;
  const [row] = await db.select({ id: events.id }).from(events).where(and(eq(events.id, eventId), eq(events.clubId, clubId)));
  if (!row) throw new Error("Aktiviteten findes ikke i foreningen.");
  return eventId;
}

export async function createTicketEvent(db: Db, ctx: AccessContext, clubId: string, input: TicketEventInput) {
  assertCan(ctx, { action: "finance.manage", clubId });
  const values = clean(input);
  const eventId = await checkLinkedEvent(db, clubId, input.eventId);
  const [e] = await db.insert(ticketEvents).values({ clubId, eventId, createdByUserId: ctx.userId, ...values }).returning();
  await logAudit(db, { action: "tickets.event_created", clubId, actorUserId: ctx.userId, targetType: "ticket_event", targetId: e.id });
  return e;
}

/** Retter arrangementet. Prisen gælder kun nye bestillinger. Pladser kan ikke sættes under det, der allerede er solgt. */
export async function updateTicketEvent(db: Db, ctx: AccessContext, id: string, input: TicketEventInput) {
  const existing = await loadTicketEvent(db, id);
  assertCan(ctx, { action: "finance.manage", clubId: existing.clubId });
  if (existing.cancelledAt) throw new Error("Arrangementet er aflyst.");
  const values = clean(input);
  const eventId = await checkLinkedEvent(db, existing.clubId, input.eventId);
  await db.transaction(async (tx) => {
    await tx.select({ id: ticketEvents.id }).from(ticketEvents).where(eq(ticketEvents.id, id)).for("update");
    if (values.capacity !== null && (await takenSeats(tx, id, new Date())) > values.capacity) throw new Error("Der er allerede solgt flere billetter, end du angiver pladser.");
    await tx.update(ticketEvents).set({ ...values, eventId }).where(eq(ticketEvents.id, id));
  });
  await logAudit(db, { action: "tickets.event_updated", clubId: existing.clubId, actorUserId: ctx.userId, targetType: "ticket_event", targetId: id });
}

/**
 * Aflyser: salget lukker, ikke betalte bestillinger annulleres og deres åbne betalingssider udløber (best effort).
 * Betalte bestillinger skal refunderes (se refundTicketOrder). Betaler en køber alligevel, før siden udløber, refunderes det automatisk.
 */
export async function cancelTicketEvent(db: Db, ctx: AccessContext, id: string, provider?: PaymentProvider) {
  const e = await loadTicketEvent(db, id);
  assertCan(ctx, { action: "finance.manage", clubId: e.clubId });
  if (e.cancelledAt) throw new Error("Arrangementet er allerede aflyst.");
  const { paid, sessions } = await db.transaction(async (tx) => {
    await tx.select({ id: ticketEvents.id }).from(ticketEvents).where(eq(ticketEvents.id, id)).for("update");
    await tx.update(ticketEvents).set({ cancelledAt: ctx.now }).where(eq(ticketEvents.id, id));
    const cancelled = await tx.update(ticketOrders).set({ status: "cancelled" }).where(and(eq(ticketOrders.ticketEventId, id), eq(ticketOrders.status, "pending"))).returning({ ref: ticketOrders.providerRef });
    const [r] = await tx.select({ n: count() }).from(ticketOrders).where(and(eq(ticketOrders.ticketEventId, id), eq(ticketOrders.status, "paid"), sql`${ticketOrders.amountOre} > 0`));
    return { paid: r.n, sessions: cancelled.flatMap((c) => (c.ref ? [c.ref] : [])) };
  });
  if (provider) {
    const [club] = await db.select({ account: clubs.stripeAccountId }).from(clubs).where(eq(clubs.id, e.clubId));
    for (const ref of sessions) await provider.expireCheckout(ref, club.account).catch((err) => console.error("Betalingssiden kunne ikke udløbe", ref, err));
  }
  await logAudit(db, { action: "tickets.event_cancelled", clubId: e.clubId, actorUserId: ctx.userId, targetType: "ticket_event", targetId: id, detail: { paidToRefund: paid } });
  return { paidToRefund: paid };
}

/** Pladser der er taget: betalte billetter og bestillinger, der stadig holder pladserne. */
async function takenSeats(tx: Pick<Db, "select">, ticketEventId: string, now: Date) {
  const [r] = await tx
    .select({ n: sql<number>`coalesce(sum(${ticketOrders.quantity}), 0)::int` })
    .from(ticketOrders)
    .where(and(eq(ticketOrders.ticketEventId, ticketEventId), or(eq(ticketOrders.status, "paid"), and(eq(ticketOrders.status, "pending"), gt(ticketOrders.expiresAt, now)))));
  return r.n;
}

const saleOpen = (e: typeof ticketEvents.$inferSelect, now: Date) => !e.cancelledAt && now < (e.saleClosesAt ?? e.startsAt);

// --- Den åbne side ---

export interface PublicTicketEvent {
  id: string;
  clubName: string;
  clubSlug: string;
  name: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  priceOre: number;
  maxPerOrder: number;
  cancelled: boolean;
  /** Kan der købes nu? */
  open: boolean;
  /** Ledige pladser; null = ubegrænset. */
  remaining: number | null;
}

export async function getPublicTicketEvent(db: Db, id: string, now = new Date()): Promise<PublicTicketEvent | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db
    .select({ e: ticketEvents, clubName: clubs.name, clubSlug: clubs.slug })
    .from(ticketEvents)
    .innerJoin(clubs, eq(clubs.id, ticketEvents.clubId))
    .where(eq(ticketEvents.id, id));
  if (!row) return null;
  const { e } = row;
  const taken = e.capacity === null ? 0 : await takenSeats(db, id, now);
  const remaining = e.capacity === null ? null : Math.max(0, e.capacity - taken);
  return {
    id: e.id,
    clubName: row.clubName,
    clubSlug: row.clubSlug,
    name: e.name,
    description: e.description,
    location: e.location,
    startsAt: e.startsAt,
    priceOre: e.priceOre,
    maxPerOrder: e.maxPerOrder,
    cancelled: !!e.cancelledAt,
    open: saleOpen(e, now) && (remaining === null || remaining > 0),
    remaining,
  };
}

export interface TicketOrderInput {
  name: string;
  email: string;
  quantity: number;
  acceptTerms: boolean;
}

export interface TicketOrderResult {
  orderToken: string;
  /** Hvor køberen sendes hen. Betalingssiden, eller billetsiden, hvis billetterne er gratis. */
  redirectUrl: string;
}

/** Opretter en bestilling uden login og starter betalingen. */
export async function createTicketOrder(
  db: Db,
  ticketEventId: string,
  input: TicketOrderInput,
  provider: PaymentProvider,
  baseUrl: string,
  mail: Mailer,
  now = new Date(),
  ip: string | null = null,
): Promise<TicketOrderResult> {
  if (!UUID.test(ticketEventId)) throw new Error("Arrangementet findes ikke.");
  const name = input.name.trim();
  if (!name) throw new Error("Skriv dit navn.");
  if (name.length > 120) throw new Error("Navnet er for langt.");
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 200) throw new Error("Skriv en gyldig e-mail.");
  if (!Number.isInteger(input.quantity) || input.quantity < 1) throw new Error("Vælg mindst én billet.");
  if (!input.acceptTerms) throw new Error("Du skal acceptere købsbetingelserne og privatlivspolitikken.");

  const ipHash = ip ? createHash("sha256").update(ip).digest("hex") : null;
  const hourAgo = new Date(now.getTime() - 3_600_000);
  if (ipHash) {
    const [{ n }] = await db.select({ n: count() }).from(ticketOrders).where(and(eq(ticketOrders.ipHash, ipHash), gt(ticketOrders.createdAt, hourAgo)));
    if (n >= MAX_ORDERS_PER_IP_PER_HOUR) throw new Error("Der er lavet mange bestillinger herfra. Prøv igen om lidt.");
  }
  const [{ pendingForEmail }] = await db
    .select({ pendingForEmail: count() })
    .from(ticketOrders)
    .where(and(eq(ticketOrders.buyerEmail, email), eq(ticketOrders.status, "pending"), gt(ticketOrders.expiresAt, now)));
  if (pendingForEmail >= MAX_PENDING_PER_EMAIL) throw new Error("Du har allerede flere bestillinger, der venter på betaling. Betal dem, eller vent lidt.");

  const accessToken = newToken();
  const order = await db.transaction(async (tx) => {
    // Lås arrangementet, så to samtidige bestillinger ikke begge tager den sidste plads.
    const [e] = await tx.select().from(ticketEvents).where(eq(ticketEvents.id, ticketEventId)).for("update");
    if (!e) throw new Error("Arrangementet findes ikke.");
    if (e.cancelledAt) throw new Error("Arrangementet er aflyst.");
    if (!saleOpen(e, now)) throw new Error("Salget er lukket.");
    if (input.quantity > e.maxPerOrder) throw new Error(`Du kan købe højst ${e.maxPerOrder} billetter ad gangen.`);
    if (e.capacity !== null) {
      const left = e.capacity - (await takenSeats(tx, e.id, now));
      if (left <= 0) throw new Error("Der er udsolgt.");
      if (input.quantity > left) throw new Error(`Der er kun ${left} billet${left === 1 ? "" : "ter"} tilbage.`);
    }
    const amountOre = e.priceOre * input.quantity;
    const free = amountOre === 0;
    const [o] = await tx
      .insert(ticketOrders)
      .values({
        ticketEventId: e.id,
        clubId: e.clubId,
        buyerName: name,
        buyerEmail: email,
        quantity: input.quantity,
        amountOre,
        status: free ? "paid" : "pending",
        paidAt: free ? now : null,
        expiresAt: free ? null : new Date(now.getTime() + HOLD_MINUTES * 60_000),
        accessToken,
        ipHash,
        createdAt: now,
      })
      .returning();
    if (free) await issueTickets(tx, o);
    return { order: o, event: e };
  });

  const orderUrl = `${baseUrl}/billetter/ordre/${accessToken}`;
  if (order.order.status === "paid") {
    await sendTicketMail(db, order.order.id, mail, baseUrl);
    return { orderToken: accessToken, redirectUrl: orderUrl };
  }
  try {
    const [club] = await db.select({ name: clubs.name, account: clubs.stripeAccountId }).from(clubs).where(eq(clubs.id, order.event.clubId));
    const session = await provider.createCheckout({
      chargeId: order.order.id,
      amountOre: order.order.amountOre,
      description: `${club.name}: ${input.quantity} × ${order.event.name}`,
      customerEmail: email,
      connectedAccountId: club.account,
      baseUrl,
      successUrl: orderUrl,
      cancelUrl: `${baseUrl}/billetter/${order.event.id}`,
      mockPath: "/billetter/test",
      expiresAt: new Date(now.getTime() + CHECKOUT_MINUTES * 60_000),
    });
    await db.update(ticketOrders).set({ provider: provider.name, providerRef: session.sessionId }).where(eq(ticketOrders.id, order.order.id));
    return { orderToken: accessToken, redirectUrl: session.url };
  } catch (e) {
    // Betalingen kunne ikke startes (fx foreningen har ikke koblet Stripe): frigiv pladserne.
    await db.update(ticketOrders).set({ status: "cancelled" }).where(eq(ticketOrders.id, order.order.id));
    throw e;
  }
}

async function issueTickets(tx: Tx, order: typeof ticketOrders.$inferSelect) {
  await tx.insert(tickets).values(Array.from({ length: order.quantity }, () => ({ orderId: order.id, ticketEventId: order.ticketEventId, clubId: order.clubId, code: newToken() })));
}

/**
 * Bekræfter en betaling fra Stripes webhook (efter signaturtjek) eller testbetalingen. Kan kaldes flere gange.
 * Giver null, hvis sessionen ikke hører til et billetkøb, så kaldet kan prøves som almindelig betaling.
 */
export async function completeTicketOrder(db: Db, sessionId: string, opts: { paymentIntentId?: string | null; amountOre?: number | null; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const [peek] = await tx.select({ id: ticketOrders.id, eventId: ticketOrders.ticketEventId }).from(ticketOrders).where(eq(ticketOrders.providerRef, sessionId));
    if (!peek) return null;
    // Samme låserækkefølge som bestillingen: arrangementet først.
    const [e] = await tx.select().from(ticketEvents).where(eq(ticketEvents.id, peek.eventId)).for("update");
    const [order] = await tx.select().from(ticketOrders).where(eq(ticketOrders.id, peek.id)).for("update");
    if (order.status === "paid" || order.status === "refunded") return { orderId: order.id, accessToken: order.accessToken, alreadyDone: true };
    if (opts.amountOre != null && opts.amountOre !== order.amountOre) throw new TicketPaymentError("Det betalte beløb passer ikke med bestillingen");
    if (order.status === "cancelled") throw new TicketPaymentError("Bestillingen er annulleret.");
    // Holdet er udløbet: er pladserne givet videre, kan billetterne ikke udstedes.
    if (order.expiresAt && order.expiresAt <= now && e.capacity !== null) {
      const taken = await takenSeats(tx, e.id, now);
      if (taken + order.quantity > e.capacity) throw new TicketPaymentError("Pladserne er givet videre.");
    }
    await tx.update(ticketOrders).set({ status: "paid", paidAt: now, expiresAt: null, providerPaymentId: opts.paymentIntentId ?? null }).where(eq(ticketOrders.id, order.id));
    await issueTickets(tx, order);
    return { orderId: order.id, accessToken: order.accessToken, alreadyDone: false };
  });
}

/**
 * En betaling, der ikke kunne give billetter (se TicketPaymentError), refunderes automatisk: betalingen gemmes på bestillingen,
 * pengene sendes tilbage, og bestillingen markeres refunderet. Kan kaldes flere gange. Fejler selve refusionen, kastes fejlen,
 * så webhooken svarer 500 og Stripe prøver igen.
 */
export async function refundFailedTicketPayment(
  db: Db,
  provider: PaymentProvider,
  sessionId: string,
  opts: { paymentIntentId?: string | null; reason: string; now?: Date },
) {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const [peek] = await tx.select({ id: ticketOrders.id }).from(ticketOrders).where(eq(ticketOrders.providerRef, sessionId));
    if (!peek) return null;
    const [order] = await tx.select().from(ticketOrders).where(eq(ticketOrders.id, peek.id)).for("update");
    if (order.status === "refunded" || order.status === "paid") return { orderId: order.id, refunded: false };
    const paymentId = opts.paymentIntentId ?? order.providerPaymentId;
    if (order.provider === "stripe" && paymentId) {
      const [club] = await tx.select({ account: clubs.stripeAccountId }).from(clubs).where(eq(clubs.id, order.clubId));
      await provider.refund(paymentId, club.account);
    }
    await tx.update(ticketOrders).set({ status: "refunded", refundedAt: now, expiresAt: null, providerPaymentId: paymentId ?? null }).where(eq(ticketOrders.id, order.id));
    await logAudit(tx, { action: "tickets.payment_auto_refunded", clubId: order.clubId, targetType: "ticket_order", targetId: order.id, detail: { reason: opts.reason, amountOre: order.amountOre } });
    return { orderId: order.id, refunded: true };
  });
}

/** Mail med linket til billetterne. Best effort: en mail, der fejler, må ikke vælte en betaling. */
export async function sendTicketMail(db: Db, orderId: string, mail: Mailer, baseUrl: string) {
  try {
    const [row] = await db
      .select({ o: ticketOrders, name: ticketEvents.name, startsAt: ticketEvents.startsAt, clubName: clubs.name })
      .from(ticketOrders)
      .innerJoin(ticketEvents, eq(ticketEvents.id, ticketOrders.ticketEventId))
      .innerJoin(clubs, eq(clubs.id, ticketOrders.clubId))
      .where(eq(ticketOrders.id, orderId));
    if (!row) return;
    await mail(
      row.o.buyerEmail,
      `Dine billetter til ${row.name}`,
      `Hej ${row.o.buyerName}\n\nTak for dit køb hos ${row.clubName}: ${row.o.quantity} billet${row.o.quantity === 1 ? "" : "ter"} til ${row.name}${row.o.amountOre > 0 ? ` (${kr(row.o.amountOre)})` : ""}.\n\nDine billetter med QR-kode ligger her. Vis dem på telefonen ved indgangen:\n${baseUrl}/billetter/ordre/${row.o.accessToken}\n\nGem mailen. Linket er din adgang til billetterne.`,
    );
  } catch (e) {
    console.error("Mail med billetter fejlede", e);
  }
}

export interface MyTicketOrder {
  status: "pending" | "paid" | "cancelled" | "refunded";
  buyerName: string;
  quantity: number;
  amountOre: number;
  event: { id: string; name: string; startsAt: Date; location: string | null; clubName: string; cancelled: boolean };
  tickets: { code: string; used: boolean; voided: boolean }[];
}

/** Køberens billetside. Kun den, der har det hemmelige link, kan se den. */
export async function getTicketOrder(db: Db, accessToken: string): Promise<MyTicketOrder | null> {
  if (!TOKEN.test(accessToken)) return null;
  const [row] = await db
    .select({ o: ticketOrders, e: ticketEvents, clubName: clubs.name })
    .from(ticketOrders)
    .innerJoin(ticketEvents, eq(ticketEvents.id, ticketOrders.ticketEventId))
    .innerJoin(clubs, eq(clubs.id, ticketOrders.clubId))
    .where(eq(ticketOrders.accessToken, accessToken));
  if (!row) return null;
  const list = await db.select().from(tickets).where(eq(tickets.orderId, row.o.id)).orderBy(asc(tickets.createdAt), asc(tickets.id));
  return {
    status: row.o.status,
    buyerName: row.o.buyerName,
    quantity: row.o.quantity,
    amountOre: row.o.amountOre,
    event: { id: row.e.id, name: row.e.name, startsAt: row.e.startsAt, location: row.e.location, clubName: row.clubName, cancelled: !!row.e.cancelledAt },
    tickets: list.map((t) => ({ code: t.code, used: !!t.usedAt, voided: !!t.voidedAt })),
  };
}

/** Testbetalingens side (uden Stripe): hvad betales der for? */
export async function getTicketCheckout(db: Db, sessionId: string) {
  const [row] = await db
    .select({ status: ticketOrders.status, amountOre: ticketOrders.amountOre, quantity: ticketOrders.quantity, name: ticketEvents.name, clubName: clubs.name, token: ticketOrders.accessToken, eventId: ticketEvents.id })
    .from(ticketOrders)
    .innerJoin(ticketEvents, eq(ticketEvents.id, ticketOrders.ticketEventId))
    .innerJoin(clubs, eq(clubs.id, ticketOrders.clubId))
    .where(eq(ticketOrders.providerRef, sessionId));
  return row ?? null;
}

// --- Foreningens overblik ---

export async function listTicketEvents(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "finance.manage", clubId });
  const rows = await db.select().from(ticketEvents).where(eq(ticketEvents.clubId, clubId)).orderBy(desc(ticketEvents.startsAt));
  const out = [];
  for (const e of rows) out.push({ ...e, ...(await ticketStats(db, e.id, ctx.now)) });
  return out;
}

async function ticketStats(db: Pick<Db, "select">, ticketEventId: string, now: Date) {
  const [r] = await db
    .select({
      sold: sql<number>`count(*) filter (where ${tickets.voidedAt} is null)::int`,
      used: sql<number>`count(*) filter (where ${tickets.voidedAt} is null and ${tickets.usedAt} is not null)::int`,
    })
    .from(tickets)
    .where(eq(tickets.ticketEventId, ticketEventId));
  const [rev] = await db
    .select({ ore: sql<number>`coalesce(sum(${ticketOrders.amountOre}), 0)::int` })
    .from(ticketOrders)
    .where(and(eq(ticketOrders.ticketEventId, ticketEventId), eq(ticketOrders.status, "paid")));
  return { sold: r.sold, used: r.used, revenueOre: rev.ore, held: await takenSeats(db, ticketEventId, now) - r.sold };
}

export async function getTicketEventForClub(db: Db, ctx: AccessContext, id: string) {
  const e = await loadTicketEvent(db, id);
  assertCan(ctx, { action: "finance.manage", clubId: e.clubId });
  return { ...e, ...(await ticketStats(db, id, ctx.now)) };
}

export async function listTicketOrders(db: Db, ctx: AccessContext, ticketEventId: string) {
  const e = await loadTicketEvent(db, ticketEventId);
  assertCan(ctx, { action: "finance.manage", clubId: e.clubId });
  return db
    .select({ id: ticketOrders.id, buyerName: ticketOrders.buyerName, buyerEmail: ticketOrders.buyerEmail, quantity: ticketOrders.quantity, amountOre: ticketOrders.amountOre, status: ticketOrders.status, createdAt: ticketOrders.createdAt, paidAt: ticketOrders.paidAt })
    .from(ticketOrders)
    .where(and(eq(ticketOrders.ticketEventId, ticketEventId), inArray(ticketOrders.status, ["paid", "refunded"])))
    .orderBy(desc(ticketOrders.createdAt))
    .limit(1000);
}

/** Refunderer en betalt bestilling. Billetterne bliver ugyldige, og pladserne frigives. */
export async function refundTicketOrder(db: Db, ctx: AccessContext, orderId: string, provider: PaymentProvider) {
  if (!UUID.test(orderId)) throw new Error("Bestillingen findes ikke.");
  const [peek] = await db.select({ clubId: ticketOrders.clubId }).from(ticketOrders).where(eq(ticketOrders.id, orderId));
  if (!peek) throw new Error("Bestillingen findes ikke.");
  assertCan(ctx, { action: "finance.manage", clubId: peek.clubId });
  const amountOre = await db.transaction(async (tx) => {
    // Rækken låses, så to samtidige klik ikke refunderer to gange. Fejler refusionen, rulles alt tilbage.
    const [order] = await tx.select().from(ticketOrders).where(eq(ticketOrders.id, orderId)).for("update");
    if (order.status !== "paid") throw new Error("Kun betalte bestillinger kan refunderes.");
    await tx.update(ticketOrders).set({ status: "refunded", refundedAt: ctx.now }).where(eq(ticketOrders.id, orderId));
    await tx.update(tickets).set({ voidedAt: ctx.now }).where(and(eq(tickets.orderId, orderId), isNull(tickets.voidedAt)));
    if (order.amountOre > 0 && order.providerPaymentId && order.provider === "stripe") {
      const [club] = await tx.select({ account: clubs.stripeAccountId }).from(clubs).where(eq(clubs.id, order.clubId));
      await provider.refund(order.providerPaymentId, club.account);
    }
    return order.amountOre;
  });
  await logAudit(db, { action: "tickets.order_refunded", clubId: peek.clubId, actorUserId: ctx.userId, targetType: "ticket_order", targetId: orderId, detail: { amountOre } });
}

// --- Scanning ---

export type TicketCheck =
  | { found: false }
  | { found: true; status: "valid" | "used" | "void" | "cancelled"; event: string; startsAt: Date; clubName: string; number: number; of: number; usedAt: Date | null };

async function loadScannable(db: Db, ctx: AccessContext, code: string) {
  // Rollen tjekkes før koden slås op, så andre ikke kan bruge siden til at afprøve koder.
  if (ctx.adminClubs.size === 0 && ctx.treasurerClubs.size === 0 && ctx.coachTeams.size === 0) throw new ForbiddenError("club.view");
  if (!TOKEN.test(code)) return null;
  const [t] = await db.select().from(tickets).where(eq(tickets.code, code));
  if (!t) return null;
  const clubTeams = await db.select({ id: teams.id }).from(teams).where(eq(teams.clubId, t.clubId));
  const staff = ctx.adminClubs.has(t.clubId) || ctx.treasurerClubs.has(t.clubId) || clubTeams.some((x) => ctx.coachTeams.has(x.id));
  // Samme svar for "findes ikke" og "ingen adgang" til dem, der ikke hører til.
  if (!staff) throw new ForbiddenError("club.view");
  return t;
}

/** Slå en billet op. Kun admin, kasserer og trænere i foreningen må scanne; andre får ForbiddenError. */
export async function checkTicket(db: Db, ctx: AccessContext, code: string): Promise<TicketCheck> {
  const t = await loadScannable(db, ctx, code);
  if (!t) return { found: false };
  const [row] = await db
    .select({ e: ticketEvents, clubName: clubs.name, quantity: ticketOrders.quantity, orderStatus: ticketOrders.status })
    .from(ticketEvents)
    .innerJoin(clubs, eq(clubs.id, ticketEvents.clubId))
    .innerJoin(ticketOrders, eq(ticketOrders.id, t.orderId))
    .where(eq(ticketEvents.id, t.ticketEventId));
  const siblings = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.orderId, t.orderId)).orderBy(asc(tickets.createdAt), asc(tickets.id));
  const status = t.voidedAt || row.orderStatus !== "paid" ? "void" : row.e.cancelledAt ? "cancelled" : t.usedAt ? "used" : "valid";
  return { found: true, status, event: row.e.name, startsAt: row.e.startsAt, clubName: row.clubName, number: siblings.findIndex((s) => s.id === t.id) + 1, of: siblings.length, usedAt: t.usedAt };
}

/** Registrerer adgang. Kun den første scanning lykkes; en billet kan ikke bruges to gange. */
export async function admitTicket(db: Db, ctx: AccessContext, code: string): Promise<TicketCheck> {
  const before = await checkTicket(db, ctx, code);
  if (!before.found || before.status !== "valid") return before;
  const done = await db
    .update(tickets)
    .set({ usedAt: ctx.now, usedByUserId: ctx.userId })
    .where(and(eq(tickets.code, code), isNull(tickets.usedAt), isNull(tickets.voidedAt)))
    .returning({ id: tickets.id });
  // Tabte kapløbet: en anden scanning nåede først.
  if (done.length === 0) return checkTicket(db, ctx, code);
  return { ...before, status: "valid", usedAt: ctx.now };
}

/** Kommende arrangementer med åbent salg, til foreningens hjemmeside. */
export async function listOpenTicketEvents(db: Db, clubId: string, now = new Date()) {
  const rows = await db
    .select()
    .from(ticketEvents)
    .where(and(eq(ticketEvents.clubId, clubId), isNull(ticketEvents.cancelledAt), sql`coalesce(${ticketEvents.saleClosesAt}, ${ticketEvents.startsAt}) > ${now.toISOString()}::timestamptz`))
    .orderBy(asc(ticketEvents.startsAt))
    .limit(10);
  const out = [];
  for (const e of rows) {
    const taken = e.capacity === null ? 0 : await takenSeats(db, e.id, now);
    out.push({ id: e.id, name: e.name, startsAt: e.startsAt, location: e.location, priceOre: e.priceOre, soldOut: e.capacity !== null && taken >= e.capacity });
  }
  return out;
}
