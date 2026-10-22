// Automatisk betaling med gemt kort. En betaler siger selv ja, når vedkommende betaler en opkrævning ("Husk kortet"), og foreningen
// skal have tilladt det. Derefter trækkes forfaldne opkrævninger for betaleren og de børn, vedkommende er værge for, automatisk.
// HoldLiv gemmer aldrig kortnummeret, kun udbyderens henvisninger. Pengene går direkte til foreningens egen Stripe-konto.
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { charges, clubs, guardianships, payments, profiles, savedCards, users } from "../db/schema";
import { assertCan, type AccessContext } from "../auth/permissions";
import { addDays, kr, localDate } from "../lib/money";
import type { PaymentProvider } from "../lib/payments";
import { logAudit } from "./audit";
import { notifyUsers, type Deliver } from "./notifications";

/** Efter så mange mislykkede forsøg stopper det automatiske træk for opkrævningen, og betaleren skal selv betale. */
export const MAX_AUTO_ATTEMPTS = 3;

/** Foreningen tillader (eller forbyder) gemte kort. Slås det fra, trækkes der ikke mere automatisk. */
export async function setAutoCharge(db: Db, ctx: AccessContext, clubId: string, enabled: boolean) {
  assertCan(ctx, { action: "finance.manage", clubId });
  await db.update(clubs).set({ autoChargeEnabled: enabled }).where(eq(clubs.id, clubId));
  await logAudit(db, { action: "autocharge.setting", clubId, actorUserId: ctx.userId, detail: { enabled } });
}

/** Efter en betaling med "Husk kortet": gemmer kortet hos betaleren. Kan kaldes flere gange; kun en gennemført betaling med ja tæller. */
export async function saveCardFromCheckout(db: Db, provider: PaymentProvider, sessionId: string, now = new Date()) {
  const [row] = await db
    .select({ p: payments, clubId: charges.clubId, account: clubs.stripeAccountId, autoChargeEnabled: clubs.autoChargeEnabled, payerUserId: payments.createdByUserId })
    .from(payments)
    .innerJoin(charges, eq(charges.id, payments.chargeId))
    .innerJoin(clubs, eq(clubs.id, charges.clubId))
    .where(eq(payments.providerRef, sessionId));
  if (!row || !row.p.saveCard || row.p.status !== "succeeded" || !row.autoChargeEnabled || !row.payerUserId) return null;
  const [payer] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, row.payerUserId));
  if (!payer) return null;
  const card = await provider.retrieveSavedCard(sessionId, row.account);
  if (!card) return null;
  await db.transaction(async (tx) => {
    await tx.update(savedCards).set({ removedAt: now }).where(and(eq(savedCards.clubId, row.clubId), eq(savedCards.payerProfileId, payer.id), isNull(savedCards.removedAt)));
    await tx.insert(savedCards).values({ clubId: row.clubId, payerProfileId: payer.id, provider: provider.name, ...card, consentAt: row.p.createdAt });
  });
  await logAudit(db, { action: "card.saved", clubId: row.clubId, actorUserId: row.payerUserId, targetType: "profile", targetId: payer.id });
  return { last4: card.last4 };
}

/** Betalerens gemte kort. */
export async function listMySavedCards(db: Db, ctx: AccessContext) {
  return db
    .select({ id: savedCards.id, clubId: savedCards.clubId, clubName: clubs.name, brand: savedCards.brand, last4: savedCards.last4, consentAt: savedCards.consentAt })
    .from(savedCards)
    .innerJoin(clubs, eq(clubs.id, savedCards.clubId))
    .where(and(eq(savedCards.payerProfileId, ctx.profileId), isNull(savedCards.removedAt)))
    .orderBy(asc(clubs.name));
}

/** Betaleren fjerner kortet, og der trækkes ikke mere. Fjernes også hos udbyderen, så godt det kan lade sig gøre. */
export async function removeSavedCard(db: Db, ctx: AccessContext, cardId: string, provider: PaymentProvider, now = new Date()) {
  const [card] = await db.select().from(savedCards).where(and(eq(savedCards.id, cardId), eq(savedCards.payerProfileId, ctx.profileId), isNull(savedCards.removedAt)));
  if (!card) throw new Error("Kortet findes ikke");
  await db.update(savedCards).set({ removedAt: now }).where(eq(savedCards.id, cardId));
  const [club] = await db.select({ account: clubs.stripeAccountId }).from(clubs).where(eq(clubs.id, card.clubId));
  try {
    await provider.removeCard({ customerId: card.customerId, paymentMethodId: card.paymentMethodId, brand: card.brand, last4: card.last4 }, club?.account ?? null);
  } catch (e) {
    console.error("Kortet kunne ikke fjernes hos udbyderen", e);
  }
  await logAudit(db, { action: "card.removed", clubId: card.clubId, actorUserId: ctx.userId });
}

function paidMessage(c: { chargeId: string; amountOre: number; description: string; clubName: string; card: { last4: string | null } }, deliver: Deliver) {
  return {
    kind: "payment" as const,
    subject: `Betalt: ${c.description}`,
    body: `${kr(c.amountOre)} er trukket fra dit gemte kort (••••${c.card.last4 ?? "????"}) til ${c.clubName}: ${c.description}.\n\nHent kvitteringen her: ${deliver.baseUrl}/betaling`,
    sms: `${kr(c.amountOre)} er trukket fra dit kort til ${c.clubName}.`,
    url: "/betaling",
    dedupeKey: `autocharge:${c.chargeId}:ok`,
  };
}

async function payerRecipient(db: Db, payerProfileId: string) {
  const [r] = await db
    .select({ userId: users.id, email: users.email, phone: profiles.phone })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(eq(profiles.id, payerProfileId));
  return r ? [r] : [];
}

/**
 * Trækker forfaldne opkrævninger fra gemte kort. Kan køres så ofte, man vil: en opkrævning prøves højst én gang i døgnet og højst
 * MAX_AUTO_ATTEMPTS gange i alt, og to samtidige kørsler kan ikke trække den samme (rækken låses ved at tælle forsøget op først).
 * Betaleren får besked om både trukne og mislykkede betalinger.
 */
/** Forælderens kort dækker kun børn, der er mindreårige på trækdagen (som isMinor: uden fødselsdato regnes som barn). Voksne børn betaler selv. */
const minorOn = (today: string) => {
  const [y, m, d] = today.split("-").map(Number);
  const cutoff = new Date(Date.UTC(y - 18, m - 1, d)).toISOString().slice(0, 10);
  return sql`(${profiles.birthDate} is null or ${profiles.birthDate} > ${cutoff})`;
};

/** Markerer en opkrævning som betalt af et automatisk træk. Kan kaldes flere gange. Giver true, hvis opkrævningen blev lukket nu. */
export async function markAutoPaid(db: Db, chargeId: string, paymentIntentId: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const pending = await tx.select({ id: payments.id }).from(payments).where(and(eq(payments.chargeId, chargeId), eq(payments.auto, true), eq(payments.status, "pending")));
    if (pending.length === 0) return false;
    await tx.update(payments).set({ status: "succeeded", completedAt: now, providerPaymentId: paymentIntentId }).where(inArray(payments.id, pending.map((p) => p.id)));
    const closed = await tx.update(charges).set({ status: "paid", paidAt: now }).where(and(eq(charges.id, chargeId), eq(charges.status, "open"))).returning({ id: charges.id });
    return closed.length > 0;
  });
}

export async function runAutoCharges(db: Db, provider: PaymentProvider, deliver: Deliver, now = new Date()) {
  const today = localDate(now);
  const dayAgo = new Date(now.getTime() - 23 * 3_600_000);
  const candidates = await db
    .select({
      chargeId: charges.id,
      clubId: charges.clubId,
      profileId: charges.profileId,
      amountOre: charges.amountOre,
      description: charges.description,
      account: clubs.stripeAccountId,
      clubName: clubs.name,
      card: savedCards,
    })
    .from(charges)
    .innerJoin(profiles, eq(profiles.id, charges.profileId))
    .innerJoin(clubs, and(eq(clubs.id, charges.clubId), eq(clubs.autoChargeEnabled, true)))
    .innerJoin(
      savedCards,
      and(
        eq(savedCards.clubId, charges.clubId),
        isNull(savedCards.removedAt),
        or(eq(savedCards.payerProfileId, charges.profileId), sql`${minorOn(today)} and exists (select 1 from ${guardianships} g where g.guardian_profile_id = ${savedCards.payerProfileId} and g.child_profile_id = ${charges.profileId})`),
      ),
    )
    .where(and(eq(charges.status, "open"), sql`${charges.amountOre} > 0`, lte(charges.dueDate, today), lt(charges.autoAttempts, MAX_AUTO_ATTEMPTS), or(isNull(charges.lastAutoAttemptAt), lt(charges.lastAutoAttemptAt, dayAgo))))
    .orderBy(asc(charges.dueDate));
  const result = { charged: 0, failed: 0, skipped: 0, unclear: 0 };
  for (const c of candidates) {
    // Tæl forsøget op først og kun, hvis rækken stadig er åben og ikke prøvet for nylig: så kan to kørsler ikke trække den samme.
    const claimed = await db
      .update(charges)
      .set({ autoAttempts: sql`${charges.autoAttempts} + 1`, lastAutoAttemptAt: now })
      .where(and(eq(charges.id, c.chargeId), eq(charges.status, "open"), lt(charges.autoAttempts, MAX_AUTO_ATTEMPTS), or(isNull(charges.lastAutoAttemptAt), lt(charges.lastAutoAttemptAt, dayAgo))))
      .returning({ attempts: charges.autoAttempts });
    if (claimed.length === 0) {
      result.skipped++;
      continue;
    }
    const attempts = claimed[0].attempts;
    // Et tidligere forsøg uden sikkert svar kan være gået igennem hos udbyderen: tjek, før der trækkes igen.
    const earlier = await db.select({ id: payments.id }).from(payments).where(and(eq(payments.chargeId, c.chargeId), eq(payments.auto, true), eq(payments.status, "pending")));
    if (earlier.length > 0) {
      let found: string | null;
      try {
        found = await provider.findPaymentForCharge(c.chargeId, c.account);
      } catch {
        // Kan ikke afgøre, om det forrige træk gik igennem: træk ikke igen.
        result.unclear++;
        continue;
      }
      if (found) {
        if (await markAutoPaid(db, c.chargeId, found, now)) {
          result.charged++;
          await notifyUsers(db, deliver, await payerRecipient(db, c.card.payerProfileId), paidMessage(c, deliver));
        }
        continue;
      }
      // Ikke fundet hos udbyderen: det uklare forsøg blev ikke gennemført.
      await db.update(payments).set({ status: "failed", completedAt: now, note: "Automatisk træk blev ikke gennemført (intet fundet hos udbyderen)" }).where(inArray(payments.id, earlier.map((p) => p.id)));
    }
    const [payment] = await db
      .insert(payments)
      .values({ chargeId: c.chargeId, provider: provider.name, amountOre: c.amountOre, auto: true, note: "Automatisk træk fra gemt kort", createdByUserId: null })
      .returning({ id: payments.id });
    const res = await provider
      .chargeSavedCard({
        chargeId: c.chargeId,
        attempt: attempts,
        amountOre: c.amountOre,
        description: `${c.clubName}: ${c.description}`,
        card: { customerId: c.card.customerId, paymentMethodId: c.card.paymentMethodId, brand: c.card.brand, last4: c.card.last4 },
        connectedAccountId: c.account,
      })
      .catch((e): { ok: false; reason: string; uncertain: boolean } => ({ ok: false, reason: e instanceof Error ? e.message : "Betalingen blev ikke gennemført", uncertain: true }));
    const to = await payerRecipient(db, c.card.payerProfileId);
    if (res.ok) {
      const closed = await db.transaction(async (tx) => {
        await tx.update(payments).set({ status: "succeeded", completedAt: now, providerPaymentId: res.paymentIntentId }).where(eq(payments.id, payment.id));
        const r = await tx.update(charges).set({ status: "paid", paidAt: now }).where(and(eq(charges.id, c.chargeId), eq(charges.status, "open"))).returning({ id: charges.id });
        return r.length > 0;
      });
      if (!closed) {
        // Betaleren nåede at betale selv imens: kortet er trukket én gang for meget, så beløbet gives tilbage med det samme.
        await provider.refund(res.paymentIntentId, c.account).catch((e) => console.error("Automatisk refusion mislykkedes", e));
        await db.update(payments).set({ status: "refunded", note: "Betalt to gange; automatisk refunderet" }).where(eq(payments.id, payment.id));
        result.skipped++;
        continue;
      }
      result.charged++;
      await notifyUsers(db, deliver, to, paidMessage(c, deliver));
    } else if (res.uncertain) {
      // Intet sikkert svar: pengene kan være trukket. Betalingen står som afventende, og der sendes ingen fejlbesked. Næste kørsel (eller webhooken) afgør det.
      await db.update(payments).set({ note: `Uklart svar fra udbyderen: ${res.reason}`.slice(0, 500) }).where(eq(payments.id, payment.id));
      result.unclear++;
    } else {
      // Fejlteksten fra udbyderen gemmes hos betalingen, men vises ikke for betaleren.
      await db.update(payments).set({ status: "failed", completedAt: now, note: `Automatisk træk mislykkedes: ${res.reason}`.slice(0, 500) }).where(eq(payments.id, payment.id));
      result.failed++;
      const last = attempts >= MAX_AUTO_ATTEMPTS;
      await notifyUsers(db, deliver, to, {
        kind: "payment",
        subject: `Betalingen til ${c.clubName} kunne ikke gennemføres`,
        body: `Vi kunne ikke trække ${kr(c.amountOre)} fra dit gemte kort til ${c.clubName}: ${c.description}.\n\n${last ? "Vi prøver ikke igen automatisk." : "Vi prøver igen i morgen."} Du kan betale selv her: ${deliver.baseUrl}/betaling`,
        sms: `Betalingen til ${c.clubName} kunne ikke gennemføres. Betal selv i HoldLiv.`,
        url: "/betaling",
        dedupeKey: `autocharge:${c.chargeId}:fail:${attempts}`,
      });
    }
  }
  if (candidates.length) await logAudit(db, { action: "autocharge.run", detail: { ...result, day: addDays(today, 0) } });
  return result;
}
