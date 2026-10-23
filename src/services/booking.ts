// Booking af baner, haller og udstyr.
//
// Regler:
//   - Foreningens admin/kasserer opretter baner, haller og udstyr og bestemmer selv lejen pr. time (0 = gratis), antal enheder
//     og om medlemmers bookinger skal godkendes. HoldLiv har ingen standardsatser.
//   - Medlemmer (eller en forælder for et barn) booker til sig selv. Koster det noget, oprettes en opkrævning under Betaling,
//     når bookingen er bekræftet. Kræver ressourcen godkendelse, ligger bookingen som "afventer", indtil foreningen svarer.
//   - Trænere og admin booker for et hold. Hold-bookinger er altid bekræftede og uden leje.
//   - Der må ikke bookes flere enheder, end ressourcen har, på samme tidspunkt. Afventende bookinger holder pladsen.
//   - Afbooking af en betalt booking kræver, at kassereren har refunderet opkrævningen først.
import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { bookingResources, bookings, charges, clubMemberships, profiles, teams } from "../db/schema";
import { assertCan, canActAs, type AccessContext } from "../auth/permissions";
import { addDays, localDate } from "../lib/money";
import { logAudit } from "./audit";
import { notifyUsers, recipientsOfPlayers, type Deliver } from "./notifications";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Teknisk øvre grænse: 10.000 kr. i timen. */
export const MAX_PRICE_PER_HOUR_ORE = 1_000_000;
const MAX_HOURS = 12;
const MAX_DAYS_AHEAD = 365;

export interface ResourceInput {
  name: string;
  kind: "court" | "hall" | "equipment";
  description?: string | null;
  quantity?: number;
  pricePerHourOre?: number;
  requiresApproval?: boolean;
}

function cleanResource(input: ResourceInput) {
  const name = input.name.trim();
  if (!name) throw new Error("Giv ressourcen et navn.");
  if (name.length > 120) throw new Error("Navnet må højst være på 120 tegn.");
  if (!["court", "hall", "equipment"].includes(input.kind)) throw new Error("Vælg om det er en bane, en hal eller udstyr.");
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw new Error("Antal skal være et helt tal fra 1 til 1.000.");
  const price = input.pricePerHourOre ?? 0;
  if (!Number.isInteger(price) || price < 0 || price > MAX_PRICE_PER_HOUR_ORE) throw new Error("Lejen skal være mellem 0 og 10.000 kr. i timen.");
  return {
    name,
    kind: input.kind,
    description: input.description?.trim() || null,
    quantity,
    pricePerHourOre: price,
    requiresApproval: !!input.requiresApproval,
  };
}

export async function createResource(db: Db, ctx: AccessContext, clubId: string, input: ResourceInput) {
  assertCan(ctx, { action: "finance.manage", clubId });
  const [r] = await db.insert(bookingResources).values({ clubId, ...cleanResource(input) }).returning();
  await logAudit(db, { action: "booking.resource_created", clubId, actorUserId: ctx.userId, targetType: "booking_resource", targetId: r.id });
  return r;
}

async function loadResource(db: Pick<Db, "select">, id: string) {
  const [r] = await db.select().from(bookingResources).where(eq(bookingResources.id, id));
  if (!r) throw new Error("Ressourcen findes ikke");
  return r;
}

/** Retter en ressource. Ny leje gælder kun nye bookinger; opkrævninger, der allerede er lavet, ændres ikke. */
export async function updateResource(db: Db, ctx: AccessContext, resourceId: string, input: ResourceInput) {
  const r = await loadResource(db, resourceId);
  assertCan(ctx, { action: "finance.manage", clubId: r.clubId });
  if (r.archivedAt) throw new Error("Ressourcen er arkiveret.");
  await db.update(bookingResources).set(cleanResource(input)).where(eq(bookingResources.id, resourceId));
  await logAudit(db, { action: "booking.resource_updated", clubId: r.clubId, actorUserId: ctx.userId, targetType: "booking_resource", targetId: resourceId });
}

/** Arkiverer en ressource: den kan ikke bookes mere, men gamle bookinger bevares. */
export async function archiveResource(db: Db, ctx: AccessContext, resourceId: string) {
  const r = await loadResource(db, resourceId);
  assertCan(ctx, { action: "finance.manage", clubId: r.clubId });
  await db.update(bookingResources).set({ archivedAt: ctx.now }).where(eq(bookingResources.id, resourceId));
  await logAudit(db, { action: "booking.resource_archived", clubId: r.clubId, actorUserId: ctx.userId, targetType: "booking_resource", targetId: resourceId });
}

/** Lejen for tidsrummet: pris pr. time og enhed, regnet pr. minut og rundet til hele øre. */
export function bookingPrice(pricePerHourOre: number, quantity: number, startsAt: Date, endsAt: Date) {
  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60000;
  return Math.round((pricePerHourOre * quantity * minutes) / 60);
}

/** Enheder, der er optaget i tidsrummet (afventende og bekræftede bookinger). */
async function usedUnits(db: Pick<Db, "select">, resourceId: string, startsAt: Date, endsAt: Date, exceptId?: string) {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${bookings.quantity}), 0)::int` })
    .from(bookings)
    .where(
      and(
        eq(bookings.resourceId, resourceId),
        inArray(bookings.status, ["pending", "confirmed"]),
        lt(bookings.startsAt, endsAt),
        gt(bookings.endsAt, startsAt),
        exceptId ? ne(bookings.id, exceptId) : undefined,
      ),
    );
  return row.n;
}

async function createBookingCharge(tx: Tx, b: typeof bookings.$inferSelect, r: typeof bookingResources.$inferSelect, userId: string | null, now: Date) {
  if (b.teamId) return null;
  const amountOre = bookingPrice(r.pricePerHourOre, b.quantity, b.startsAt, b.endsAt);
  if (amountOre === 0) return null;
  const today = localDate(now);
  const day = localDate(b.startsAt);
  const due = day < addDays(today, 14) ? (day < today ? today : day) : addDays(today, 14);
  const [charge] = await tx
    .insert(charges)
    .values({
      clubId: b.clubId,
      profileId: b.profileId,
      description: `Leje: ${r.name}${b.quantity > 1 ? ` (${b.quantity} stk.)` : ""}, ${day}`,
      amountOre,
      periodStart: day,
      periodEnd: day,
      dueDate: due,
      kind: "booking",
      createdByUserId: userId,
    })
    .returning({ id: charges.id });
  await tx.update(bookings).set({ chargeId: charge.id }).where(eq(bookings.id, b.id));
  return { chargeId: charge.id, amountOre };
}

export interface BookingInput {
  resourceId: string;
  startsAt: Date;
  endsAt: Date;
  quantity?: number;
  note?: string | null;
  /** Booker for et hold (træner/admin). Ellers for en selv eller et barn, man er værge for. */
  teamId?: string | null;
  /** Profilen bookingen er for. Standard: ens egen. Ignoreres for holdbookinger. */
  profileId?: string;
}

/** Booker en ressource. Giver status "confirmed" eller "pending" og evt. lejen. */
export async function createBooking(db: Db, ctx: AccessContext, input: BookingInput) {
  const resource0 = await loadResource(db, input.resourceId);
  const { startsAt, endsAt } = input;
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new Error("Vælg start og slut.");
  if (endsAt.getTime() - startsAt.getTime() < 15 * 60000) throw new Error("Bookingen skal vare mindst 15 minutter.");
  if (endsAt.getTime() - startsAt.getTime() > MAX_HOURS * 3600000) throw new Error(`Bookingen må højst vare ${MAX_HOURS} timer.`);
  if (startsAt.getTime() < ctx.now.getTime()) throw new Error("Starttidspunktet ligger i fortiden.");
  if (startsAt.getTime() > ctx.now.getTime() + MAX_DAYS_AHEAD * 86400000) throw new Error("Man kan højst booke et år frem.");
  const quantity = input.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("Antal skal være mindst 1.");
  if (quantity > resource0.quantity) throw new Error(`Der er kun ${resource0.quantity} af ${resource0.name}.`);
  if (resource0.archivedAt) throw new Error("Ressourcen er arkiveret.");

  let profileId = input.profileId ?? ctx.profileId;
  const teamId = input.teamId || null;
  let status: "confirmed" | "pending";
  if (teamId) {
    const [team] = await db.select({ id: teams.id, clubId: teams.clubId }).from(teams).where(eq(teams.id, teamId));
    if (!team || team.clubId !== resource0.clubId) throw new Error("Holdet hører ikke til foreningen.");
    assertCan(ctx, { action: "team.manage", team: { teamId, clubId: team.clubId } });
    profileId = ctx.profileId;
    status = "confirmed";
  } else {
    if (!canActAs(ctx, profileId)) assertCan(ctx, { action: "profile.actAs", profileId });
    const [m] = await db
      .select({ p: clubMemberships.profileId })
      .from(clubMemberships)
      .where(and(eq(clubMemberships.clubId, resource0.clubId), eq(clubMemberships.profileId, profileId)));
    if (!m) throw new Error("Kun medlemmer af foreningen kan booke.");
    const manager = ctx.adminClubs.has(resource0.clubId) || ctx.treasurerClubs.has(resource0.clubId);
    status = resource0.requiresApproval && !manager ? "pending" : "confirmed";
  }

  const result = await db.transaction(async (tx) => {
    // Lås ressourcen, så to samtidige bookinger ikke begge tager den sidste enhed.
    const [resource] = await tx.select().from(bookingResources).where(eq(bookingResources.id, input.resourceId)).for("update");
    if (resource.archivedAt) throw new Error("Ressourcen er arkiveret.");
    const used = await usedUnits(tx, resource.id, startsAt, endsAt);
    if (used + quantity > resource.quantity) {
      throw new Error(resource.quantity === 1 ? `${resource.name} er optaget i det tidsrum.` : `Der er kun ${resource.quantity - used} ledige af ${resource.name} i det tidsrum.`);
    }
    const [b] = await tx
      .insert(bookings)
      .values({ resourceId: resource.id, clubId: resource.clubId, profileId, teamId, bookedByUserId: ctx.userId, startsAt, endsAt, quantity, note: input.note?.trim() || null, status })
      .returning();
    const charge = status === "confirmed" ? await createBookingCharge(tx, b, resource, ctx.userId, ctx.now) : null;
    return { booking: b, amountOre: charge?.amountOre ?? 0 };
  });
  await logAudit(db, { action: "booking.created", clubId: resource0.clubId, actorUserId: ctx.userId, targetType: "booking", targetId: result.booking.id, detail: { status, teamId } });
  return { id: result.booking.id, status, amountOre: result.amountOre };
}

async function loadBooking(db: Pick<Db, "select">, id: string) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id));
  if (!b) throw new Error("Bookingen findes ikke");
  return b;
}

/** Foreningen godkender en afventende booking: opkrævningen oprettes og personen får besked. */
export async function approveBooking(db: Db, ctx: AccessContext, bookingId: string, deliver?: Deliver) {
  const b0 = await loadBooking(db, bookingId);
  assertCan(ctx, { action: "finance.manage", clubId: b0.clubId });
  const amountOre = await db.transaction(async (tx) => {
    const [r] = await tx.select().from(bookingResources).where(eq(bookingResources.id, b0.resourceId)).for("update");
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, bookingId));
    if (b.status !== "pending") throw new Error("Bookingen afventer ikke godkendelse.");
    if (b.startsAt.getTime() < ctx.now.getTime()) throw new Error("Bookingen ligger i fortiden.");
    await tx.update(bookings).set({ status: "confirmed" }).where(eq(bookings.id, bookingId));
    const charge = await createBookingCharge(tx, b, r, ctx.userId, ctx.now);
    return charge?.amountOre ?? 0;
  });
  await logAudit(db, { action: "booking.approved", clubId: b0.clubId, actorUserId: ctx.userId, targetType: "booking", targetId: bookingId });
  await notifyBooker(db, deliver, b0, ctx.now, "bekræftet", amountOre > 0 ? " Lejen finder du under Betaling." : "");
}

/** Foreningen afviser en afventende booking. */
export async function rejectBooking(db: Db, ctx: AccessContext, bookingId: string, deliver?: Deliver) {
  const b = await loadBooking(db, bookingId);
  assertCan(ctx, { action: "finance.manage", clubId: b.clubId });
  if (b.status !== "pending") throw new Error("Bookingen afventer ikke godkendelse.");
  await db.update(bookings).set({ status: "rejected", cancelledAt: ctx.now }).where(eq(bookings.id, bookingId));
  await logAudit(db, { action: "booking.rejected", clubId: b.clubId, actorUserId: ctx.userId, targetType: "booking", targetId: bookingId });
  await notifyBooker(db, deliver, b, ctx.now, "afvist", "");
}

async function notifyBooker(db: Db, deliver: Deliver | undefined, b: typeof bookings.$inferSelect, now: Date, verb: string, extra: string) {
  if (!deliver) return;
  const r = await loadResource(db, b.resourceId);
  await notifyUsers(db, deliver, await recipientsOfPlayers(db, [b.profileId], now), {
    kind: "event_change",
    subject: `Din booking af ${r.name} er ${verb}`,
    body: `Din booking af ${r.name} den ${localDate(b.startsAt)} er ${verb}.${extra}`,
    sms: `Din booking af ${r.name} er ${verb}.`,
    url: "/booking",
    dedupeKey: `booking:${b.id}:${verb}`,
  });
}

/** Afbooker: den bookingen er for (eller forælderen), holdets træner, eller foreningens admin/kasserer. En betalt booking skal først refunderes. */
export async function cancelBooking(db: Db, ctx: AccessContext, bookingId: string) {
  const b = await loadBooking(db, bookingId);
  if (b.status === "cancelled" || b.status === "rejected") throw new Error("Bookingen er allerede annulleret.");
  const manager = ctx.adminClubs.has(b.clubId) || ctx.treasurerClubs.has(b.clubId);
  const own = canActAs(ctx, b.profileId) || (b.teamId !== null && (ctx.coachTeams.has(b.teamId) || ctx.adminClubs.has(b.clubId)));
  if (!own && !manager) assertCan(ctx, { action: "finance.manage", clubId: b.clubId });
  if (!manager && b.startsAt.getTime() <= ctx.now.getTime()) throw new Error("Bookingen er begyndt og kan ikke afbooks.");
  if (b.chargeId) {
    const [c] = await db.select({ status: charges.status }).from(charges).where(eq(charges.id, b.chargeId));
    if (c?.status === "paid") throw new Error("Lejen er betalt. Kassereren skal refundere beløbet, før du kan afbooke.");
  }
  await db.transaction(async (tx) => {
    await tx.update(bookings).set({ status: "cancelled", cancelledAt: ctx.now }).where(eq(bookings.id, bookingId));
    if (b.chargeId) await tx.update(charges).set({ status: "cancelled" }).where(and(eq(charges.id, b.chargeId), eq(charges.status, "open")));
  });
  await logAudit(db, { action: "booking.cancelled", clubId: b.clubId, actorUserId: ctx.userId, targetType: "booking", targetId: bookingId });
}

export async function listClubResources(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "finance.manage", clubId });
  return db.select().from(bookingResources).where(and(eq(bookingResources.clubId, clubId), isNull(bookingResources.archivedAt))).orderBy(asc(bookingResources.kind), asc(bookingResources.name));
}

/** Kommende bookinger i foreningen, afventende først. Kun admin/kasserer. */
export async function listClubBookings(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "finance.manage", clubId });
  const rows = await db
    .select({
      id: bookings.id,
      resourceName: bookingResources.name,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      quantity: bookings.quantity,
      note: bookings.note,
      status: bookings.status,
      teamName: teams.name,
      firstName: profiles.firstName,
      lastName: profiles.lastName,
      amountOre: charges.amountOre,
      chargeStatus: charges.status,
    })
    .from(bookings)
    .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
    .innerJoin(profiles, eq(profiles.id, bookings.profileId))
    .leftJoin(teams, eq(teams.id, bookings.teamId))
    .leftJoin(charges, eq(charges.id, bookings.chargeId))
    .where(and(eq(bookings.clubId, clubId), gt(bookings.endsAt, ctx.now), inArray(bookings.status, ["pending", "confirmed"])))
    .orderBy(asc(bookings.startsAt));
  return [...rows.filter((r) => r.status === "pending"), ...rows.filter((r) => r.status !== "pending")];
}

/**
 * Det man selv kan booke: ressourcer i foreningerne, man (eller ens børn) er medlem af, med kommende optagne tider
 * (kun hvem: holdets navn eller fornavn), de personer man kan booke for, og de hold man kan booke for.
 */
export async function listBookableResources(db: Db, ctx: AccessContext) {
  const people = [ctx.profileId, ...ctx.wards];
  const memberships = await db.select({ clubId: clubMemberships.clubId, profileId: clubMemberships.profileId }).from(clubMemberships).where(inArray(clubMemberships.profileId, people));
  const clubIds = [...new Set(memberships.map((m) => m.clubId))];
  if (clubIds.length === 0) return [];
  const resources = await db
    .select()
    .from(bookingResources)
    .where(and(inArray(bookingResources.clubId, clubIds), isNull(bookingResources.archivedAt)))
    .orderBy(asc(bookingResources.kind), asc(bookingResources.name));
  const horizon = new Date(ctx.now.getTime() + 14 * 86400000);
  const busy = resources.length
    ? await db
        .select({
          resourceId: bookings.resourceId,
          startsAt: bookings.startsAt,
          endsAt: bookings.endsAt,
          quantity: bookings.quantity,
          status: bookings.status,
          teamName: teams.name,
          firstName: profiles.firstName,
        })
        .from(bookings)
        .innerJoin(profiles, eq(profiles.id, bookings.profileId))
        .leftJoin(teams, eq(teams.id, bookings.teamId))
        .where(and(inArray(bookings.resourceId, resources.map((r) => r.id)), inArray(bookings.status, ["pending", "confirmed"]), gt(bookings.endsAt, ctx.now), lt(bookings.startsAt, horizon)))
        .orderBy(asc(bookings.startsAt))
    : [];
  const nameRows = await db.select({ id: profiles.id, firstName: profiles.firstName }).from(profiles).where(inArray(profiles.id, people));
  const names = new Map(nameRows.map((p) => [p.id, p.firstName]));
  const leadTeams = ctx.coachTeams.size
    ? await db.select({ id: teams.id, name: teams.name, clubId: teams.clubId }).from(teams).where(inArray(teams.id, [...ctx.coachTeams]))
    : [];
  const adminTeams = ctx.adminClubs.size ? await db.select({ id: teams.id, name: teams.name, clubId: teams.clubId }).from(teams).where(inArray(teams.clubId, [...ctx.adminClubs])) : [];
  const allTeams = [...new Map([...leadTeams, ...adminTeams].map((t) => [t.id, t])).values()];
  return resources.map((r) => ({
    ...r,
    busy: busy.filter((b) => b.resourceId === r.id).map((b) => ({ startsAt: b.startsAt, endsAt: b.endsAt, quantity: b.quantity, pending: b.status === "pending", who: b.teamName ?? b.firstName })),
    people: memberships.filter((m) => m.clubId === r.clubId).map((m) => ({ profileId: m.profileId, firstName: names.get(m.profileId) ?? "", self: m.profileId === ctx.profileId })),
    teams: allTeams.filter((t) => t.clubId === r.clubId),
  }));
}

/** Egne kommende bookinger (og børnenes) samt dem man har lavet for et hold. */
export async function listMyBookings(db: Db, ctx: AccessContext) {
  const people = [ctx.profileId, ...ctx.wards];
  return db
    .select({
      id: bookings.id,
      resourceName: bookingResources.name,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      quantity: bookings.quantity,
      status: bookings.status,
      teamName: teams.name,
      firstName: profiles.firstName,
      profileId: bookings.profileId,
      amountOre: charges.amountOre,
    })
    .from(bookings)
    .innerJoin(bookingResources, eq(bookingResources.id, bookings.resourceId))
    .innerJoin(profiles, eq(profiles.id, bookings.profileId))
    .leftJoin(teams, eq(teams.id, bookings.teamId))
    .leftJoin(charges, eq(charges.id, bookings.chargeId))
    .where(and(inArray(bookings.profileId, people), gt(bookings.endsAt, ctx.now), inArray(bookings.status, ["pending", "confirmed"])))
    .orderBy(asc(bookings.startsAt));
}
