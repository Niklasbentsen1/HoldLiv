// Medlemmer, kontingent og betaling: kassererens værktøj og forældrenes betalingsside.
// Kassereren (og admin) styrer satser, opkrævninger og registrerer betalinger.
// Medlemmet selv eller forælderen betaler. Pengene går direkte til foreningens egen Stripe-konto.
import { and, asc, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  charges,
  clubMemberships,
  clubRoles,
  clubs,
  guardianships,
  membershipFees,
  payments,
  profiles,
  teamMembers,
  teams,
  users,
} from "../db/schema";
import { assertCan, can, isMinor, type AccessContext } from "../auth/permissions";
import { loadTeamFacts } from "../auth/context";
import { logAudit } from "./audit";
import { addDays, kr, localDate, longDate, periodContaining, periodLabel, type FeeInterval } from "../lib/money";
import type { PaymentProvider } from "../lib/payments";
import type { Mailer } from "../lib/mail";

const financeClubIds = (ctx: AccessContext) => [...new Set([...ctx.adminClubs, ...ctx.treasurerClubs])];

/** Foreninger hvor login'et er admin eller kasserer. */
export async function listFinanceClubs(db: Db, ctx: AccessContext) {
  const ids = financeClubIds(ctx);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: clubs.id, name: clubs.name, stripeAccountId: clubs.stripeAccountId })
    .from(clubs)
    .where(inArray(clubs.id, ids))
    .orderBy(asc(clubs.name));
  return rows.map(({ stripeAccountId, ...c }) => ({ ...c, paymentsConnected: !!stripeAccountId }));
}

// --- Kasserer-rollen ---

async function profileByEmail(db: Db, email: string) {
  const [row] = await db
    .select({ profileId: profiles.id })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(eq(users.email, email.trim().toLowerCase()));
  if (!row) throw new Error("Der er ingen i HoldLiv med den e-mail endnu. Bed personen logge ind én gang først.");
  return row.profileId;
}

/** Admin udpeger en kasserer. Kassereren får adgang til medlemmer og økonomi, ikke til hold og trænere. */
export async function grantTreasurerByEmail(db: Db, ctx: AccessContext, clubId: string, email: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  const profileId = await profileByEmail(db, email);
  await db.transaction(async (tx) => {
    await tx.insert(clubMemberships).values({ clubId, profileId, exempt: true }).onConflictDoNothing();
    await tx.insert(clubRoles).values({ clubId, profileId, role: "treasurer", title: "Kasserer" }).onConflictDoNothing();
  });
  await logAudit(db, { action: "club.treasurer_granted", clubId, actorUserId: ctx.userId, targetType: "profile", targetId: profileId });
}

export async function revokeTreasurer(db: Db, ctx: AccessContext, clubId: string, profileId: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  await db
    .delete(clubRoles)
    .where(and(eq(clubRoles.clubId, clubId), eq(clubRoles.profileId, profileId), eq(clubRoles.role, "treasurer")));
  await logAudit(db, { action: "club.treasurer_revoked", clubId, actorUserId: ctx.userId, targetType: "profile", targetId: profileId });
}

export async function listTreasurers(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  return db
    .select({ profileId: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(clubRoles)
    .innerJoin(profiles, eq(profiles.id, clubRoles.profileId))
    .where(and(eq(clubRoles.clubId, clubId), eq(clubRoles.role, "treasurer")))
    .orderBy(asc(profiles.firstName));
}

// --- Kontingentsatser ---

export interface FeeInput {
  name: string;
  amountOre: number;
  interval: FeeInterval;
}

function checkFee(input: Partial<FeeInput>) {
  if (input.name !== undefined && !input.name.trim()) throw new Error("Giv kontingentet et navn");
  if (input.amountOre !== undefined && (!Number.isInteger(input.amountOre) || input.amountOre < 0)) {
    throw new Error("Beløbet skal være 0 kr. eller mere");
  }
}

export async function listFees(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "finance.manage", clubId });
  const [fees, counts, teamRows] = await Promise.all([
    db.select().from(membershipFees).where(eq(membershipFees.clubId, clubId)).orderBy(asc(membershipFees.name)),
    db
      .select({ feeId: clubMemberships.feeId, n: sql<number>`count(*)::int` })
      .from(clubMemberships)
      .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.status, "active"), eq(clubMemberships.exempt, false)))
      .groupBy(clubMemberships.feeId),
    db.select({ id: teams.id, name: teams.name, defaultFeeId: teams.defaultFeeId }).from(teams).where(eq(teams.clubId, clubId)).orderBy(asc(teams.name)),
  ]);
  return {
    fees: fees.map((f) => ({ ...f, members: counts.find((c) => c.feeId === f.id)?.n ?? 0 })),
    teams: teamRows,
    withoutFee: counts.find((c) => c.feeId === null)?.n ?? 0,
  };
}

export async function createFee(db: Db, ctx: AccessContext, clubId: string, input: FeeInput) {
  assertCan(ctx, { action: "finance.manage", clubId });
  checkFee(input);
  const [fee] = await db.insert(membershipFees).values({ clubId, ...input, name: input.name.trim() }).returning();
  await logAudit(db, { action: "fee.created", clubId, actorUserId: ctx.userId, targetType: "fee", targetId: fee.id, detail: { name: fee.name, amountOre: fee.amountOre } });
  return fee;
}

async function loadFee(db: Db, feeId: string) {
  const [fee] = await db.select().from(membershipFees).where(eq(membershipFees.id, feeId));
  if (!fee) throw new Error("Kontingentet findes ikke");
  return fee;
}

/** Navn, beløb og interval kan altid ændres. Det gælder kommende opkrævninger; udsendte beholder deres beløb. */
export async function updateFee(db: Db, ctx: AccessContext, feeId: string, patch: Partial<FeeInput>) {
  const fee = await loadFee(db, feeId);
  assertCan(ctx, { action: "finance.manage", clubId: fee.clubId });
  checkFee(patch);
  const [f] = await db.update(membershipFees).set(patch).where(eq(membershipFees.id, feeId)).returning();
  await logAudit(db, { action: "fee.updated", clubId: fee.clubId, actorUserId: ctx.userId, targetType: "fee", targetId: feeId, detail: patch });
  return f;
}

export async function setFeeArchived(db: Db, ctx: AccessContext, feeId: string, archived: boolean) {
  const fee = await loadFee(db, feeId);
  assertCan(ctx, { action: "finance.manage", clubId: fee.clubId });
  await db.update(membershipFees).set({ archivedAt: archived ? new Date() : null }).where(eq(membershipFees.id, feeId));
}

/** Holdets standardkontingent, som nye spillere får automatisk. */
export async function setTeamDefaultFee(db: Db, ctx: AccessContext, teamId: string, feeId: string | null) {
  const team = await loadTeamFacts(db, teamId);
  assertCan(ctx, { action: "finance.manage", clubId: team.clubId });
  if (feeId && (await loadFee(db, feeId)).clubId !== team.clubId) throw new Error("Kontingentet hører til en anden forening");
  await db.update(teams).set({ defaultFeeId: feeId }).where(eq(teams.id, teamId));
}

// --- Medlemmer ---

export type MemberFilter = "active" | "no_fee" | "exempt" | "overdue" | "inactive" | "all";

export async function listMembers(db: Db, ctx: AccessContext, clubId: string, opts: { filter?: MemberFilter; q?: string } = {}) {
  assertCan(ctx, { action: "finance.manage", clubId });
  const today = localDate(ctx.now);
  const rows = await db
    .select({
      profileId: profiles.id,
      firstName: profiles.firstName,
      lastName: profiles.lastName,
      birthDate: profiles.birthDate,
      email: profiles.email,
      phone: profiles.phone,
      status: clubMemberships.status,
      feeId: clubMemberships.feeId,
      feeName: membershipFees.name,
      exempt: clubMemberships.exempt,
      joinedAt: clubMemberships.joinedAt,
      leftAt: clubMemberships.leftAt,
    })
    .from(clubMemberships)
    .innerJoin(profiles, eq(profiles.id, clubMemberships.profileId))
    .leftJoin(membershipFees, eq(membershipFees.id, clubMemberships.feeId))
    .where(eq(clubMemberships.clubId, clubId))
    .orderBy(asc(profiles.firstName), asc(profiles.lastName));
  const ids = rows.map((r) => r.profileId);
  if (ids.length === 0) return [];

  const [teamRows, guardianRows, openRows] = await Promise.all([
    db
      .select({ profileId: teamMembers.profileId, name: teams.name, role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teams.clubId, clubId), inArray(teamMembers.profileId, ids))),
    db
      .select({ childId: guardianships.childProfileId, firstName: profiles.firstName, lastName: profiles.lastName, email: profiles.email, phone: profiles.phone })
      .from(guardianships)
      .innerJoin(profiles, eq(profiles.id, guardianships.guardianProfileId))
      .where(inArray(guardianships.childProfileId, ids)),
    db
      .select({ profileId: charges.profileId, amountOre: charges.amountOre, dueDate: charges.dueDate })
      .from(charges)
      .where(and(eq(charges.clubId, clubId), eq(charges.status, "open"))),
  ]);

  const q = opts.q?.trim().toLowerCase();
  return rows
    .map((r) => {
      const open = openRows.filter((c) => c.profileId === r.profileId);
      const minor = isMinor(r.birthDate, ctx.now);
      return {
        ...r,
        minor,
        teams: teamRows.filter((t) => t.profileId === r.profileId).map((t) => (t.role === "coach" ? `${t.name} (træner)` : t.name)),
        guardians: minor ? guardianRows.filter((g) => g.childId === r.profileId).map(({ childId, ...g }) => g) : [],
        openOre: open.reduce((s, c) => s + c.amountOre, 0),
        overdue: open.some((c) => c.dueDate < today),
      };
    })
    .filter((m) => {
      if (q && !`${m.firstName} ${m.lastName} ${m.email ?? ""} ${m.guardians.map((g) => `${g.firstName} ${g.lastName}`).join(" ")}`.toLowerCase().includes(q)) return false;
      switch (opts.filter ?? "active") {
        case "active":
          return m.status === "active";
        case "no_fee":
          return m.status === "active" && !m.exempt && !m.feeId;
        case "exempt":
          return m.status === "active" && m.exempt;
        case "overdue":
          return m.overdue;
        case "inactive":
          return m.status !== "active";
        case "all":
          return true;
      }
    });
}

export interface MembershipPatch {
  feeId?: string | null;
  exempt?: boolean;
  /** inactive = udmeldt. Udmeldte får ingen nye opkrævninger, men historikken bevares. */
  status?: "active" | "inactive";
}

export async function updateMembership(db: Db, ctx: AccessContext, clubId: string, profileId: string, patch: MembershipPatch) {
  assertCan(ctx, { action: "finance.manage", clubId });
  if (patch.feeId) {
    const fee = await loadFee(db, patch.feeId);
    if (fee.clubId !== clubId) throw new Error("Kontingentet hører til en anden forening");
    if (fee.archivedAt) throw new Error("Kontingentet er arkiveret");
  }
  const set: Partial<typeof clubMemberships.$inferInsert> = {};
  if (patch.feeId !== undefined) set.feeId = patch.feeId;
  if (patch.exempt !== undefined) set.exempt = patch.exempt;
  if (patch.status) {
    set.status = patch.status;
    set.leftAt = patch.status === "inactive" ? ctx.now : null;
  }
  const updated = await db
    .update(clubMemberships)
    .set(set)
    .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.profileId, profileId)))
    .returning();
  if (updated.length === 0) throw new Error("Personen er ikke medlem af foreningen");
  await logAudit(db, { action: "member.updated", clubId, actorUserId: ctx.userId, targetType: "profile", targetId: profileId, detail: { ...patch } });
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Semikolon, fordi dansk Excel bruger det som skilletegn. Formler neutraliseres.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[;"\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Medlemsliste til regneark, fx til kommunens tilskud eller DIF/DGI's medlemstal. */
export async function membersCsv(db: Db, ctx: AccessContext, clubId: string) {
  const members = await listMembers(db, ctx, clubId, { filter: "all" });
  await logAudit(db, { action: "members.exported", clubId, actorUserId: ctx.userId, detail: { rows: members.length } });
  const header = ["Fornavn", "Efternavn", "Fødselsdato", "E-mail", "Telefon", "Hold", "Forældre", "Kontingent", "Gratist", "Status", "Indmeldt", "Udmeldt", "Skylder (kr.)"];
  const lines = members.map((m) =>
    [
      m.firstName,
      m.lastName,
      m.birthDate,
      m.email,
      m.phone,
      m.teams.join(", "),
      m.guardians.map((g) => `${g.firstName} ${g.lastName}${g.phone ? ` (${g.phone})` : ""}`).join(", "),
      m.feeName,
      m.exempt ? "ja" : "",
      m.status === "active" ? "aktiv" : "udmeldt",
      localDate(m.joinedAt),
      m.leftAt ? localDate(m.leftAt) : "",
      (m.openOre / 100).toFixed(2).replace(".", ","),
    ]
      .map(csvCell)
      .join(";"),
  );
  // BOM, så Excel læser æ, ø og å rigtigt.
  return "﻿" + [header.join(";"), ...lines].join("\r\n") + "\r\n";
}

// --- Opkrævninger ---

/** Aktive, betalende medlemmer på kontingentet, der ikke allerede er opkrævet for perioden. */
async function chargeRunCandidates(db: Db, feeId: string, periodStart: string) {
  return db
    .select({ profileId: clubMemberships.profileId, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(clubMemberships)
    .innerJoin(profiles, eq(profiles.id, clubMemberships.profileId))
    .leftJoin(charges, and(eq(charges.profileId, clubMemberships.profileId), eq(charges.feeId, feeId), eq(charges.periodStart, periodStart)))
    .where(
      and(
        eq(clubMemberships.feeId, feeId),
        eq(clubMemberships.status, "active"),
        eq(clubMemberships.exempt, false),
        isNull(charges.id),
      ),
    )
    .orderBy(asc(profiles.firstName));
}

export async function previewChargeRun(db: Db, ctx: AccessContext, feeId: string, date: string) {
  const fee = await loadFee(db, feeId);
  assertCan(ctx, { action: "finance.manage", clubId: fee.clubId });
  const period = periodContaining(fee.interval, date);
  const members = await chargeRunCandidates(db, feeId, period.start);
  return { fee, period, label: periodLabel(fee.interval, period.start), members, totalOre: members.length * fee.amountOre };
}

/**
 * Opkræver kontingent for perioden der indeholder `date`, hos alle aktive medlemmer på satsen.
 * Kan køres igen, fx når nye medlemmer er kommet til: allerede opkrævede springes over.
 */
export async function runCharges(db: Db, ctx: AccessContext, feeId: string, date: string, dueDate?: string) {
  const fee = await loadFee(db, feeId);
  assertCan(ctx, { action: "finance.manage", clubId: fee.clubId });
  if (fee.archivedAt) throw new Error("Kontingentet er arkiveret");
  const period = periodContaining(fee.interval, date);
  const due = dueDate || addDays(localDate(ctx.now) > period.start ? localDate(ctx.now) : period.start, 14);
  const members = await chargeRunCandidates(db, feeId, period.start);
  if (members.length === 0) return { created: 0, totalOre: 0 };
  const description = `${fee.name}, ${periodLabel(fee.interval, period.start)}`;
  const created = await db
    .insert(charges)
    .values(
      members.map((m) => ({
        clubId: fee.clubId,
        profileId: m.profileId,
        feeId,
        description,
        amountOre: fee.amountOre,
        periodStart: period.start,
        periodEnd: period.end,
        dueDate: due,
        // 0-kroners kontingent opkræves ikke, men registreres som betalt, så historikken er hel.
        status: fee.amountOre === 0 ? ("paid" as const) : ("open" as const),
        paidAt: fee.amountOre === 0 ? ctx.now : null,
        createdByUserId: ctx.userId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: charges.id });
  await logAudit(db, { action: "charges.run", clubId: fee.clubId, actorUserId: ctx.userId, targetType: "fee", targetId: feeId, detail: { created: created.length, period: period.start } });
  return { created: created.length, totalOre: created.length * fee.amountOre };
}

/** Enkeltopkrævning, fx et stævne eller et tøjsæt, til ét medlem. */
export async function createSingleCharge(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  profileId: string,
  input: { description: string; amountOre: number; dueDate: string },
) {
  assertCan(ctx, { action: "finance.manage", clubId });
  if (!input.description.trim()) throw new Error("Skriv hvad opkrævningen gælder");
  if (!Number.isInteger(input.amountOre) || input.amountOre <= 0) throw new Error("Beløbet skal være over 0 kr.");
  const [m] = await db.select().from(clubMemberships).where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.profileId, profileId)));
  if (!m) throw new Error("Personen er ikke medlem af foreningen");
  const today = localDate(ctx.now);
  const [c] = await db
    .insert(charges)
    .values({ clubId, profileId, description: input.description.trim(), amountOre: input.amountOre, periodStart: today, periodEnd: today, dueDate: input.dueDate, createdByUserId: ctx.userId })
    .returning();
  return c;
}

export type ChargeFilter = "open" | "overdue" | "paid" | "all";

export async function listCharges(db: Db, ctx: AccessContext, clubId: string, filter: ChargeFilter = "open") {
  assertCan(ctx, { action: "finance.manage", clubId });
  const today = localDate(ctx.now);
  const where = and(
    eq(charges.clubId, clubId),
    filter === "open" ? eq(charges.status, "open") : undefined,
    filter === "overdue" ? and(eq(charges.status, "open"), lt(charges.dueDate, today)) : undefined,
    filter === "paid" ? or(eq(charges.status, "paid"), eq(charges.status, "refunded")) : undefined,
  );
  const rows = await db
    .select({
      id: charges.id,
      profileId: charges.profileId,
      firstName: profiles.firstName,
      lastName: profiles.lastName,
      description: charges.description,
      amountOre: charges.amountOre,
      dueDate: charges.dueDate,
      status: charges.status,
      paidAt: charges.paidAt,
      remindedAt: charges.remindedAt,
      reminderCount: charges.reminderCount,
    })
    .from(charges)
    .innerJoin(profiles, eq(profiles.id, charges.profileId))
    .where(where)
    .orderBy(filter === "paid" ? desc(charges.paidAt) : asc(charges.dueDate), asc(profiles.firstName))
    .limit(500);

  const paymentRows = rows.length
    ? await db
        .select({ chargeId: payments.chargeId, provider: payments.provider, note: payments.note, status: payments.status })
        .from(payments)
        .where(and(inArray(payments.chargeId, rows.map((r) => r.id)), ne(payments.status, "pending")))
    : [];
  return rows.map((r) => {
    const paid = paymentRows.find((p) => p.chargeId === r.id && (p.status === "succeeded" || p.status === "refunded"));
    return { ...r, overdue: r.status === "open" && r.dueDate < today, paidVia: paid?.provider ?? null, paymentNote: paid?.note ?? null };
  });
}

/** Tal til kassererens forside. */
export async function financeOverview(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "finance.manage", clubId });
  const today = localDate(ctx.now);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const [[m], [c], [club]] = await Promise.all([
    db
      .select({
        active: sql<number>`count(*) filter (where ${clubMemberships.status} = 'active')::int`,
        noFee: sql<number>`count(*) filter (where ${clubMemberships.status} = 'active' and not ${clubMemberships.exempt} and ${clubMemberships.feeId} is null)::int`,
        exempt: sql<number>`count(*) filter (where ${clubMemberships.status} = 'active' and ${clubMemberships.exempt})::int`,
      })
      .from(clubMemberships)
      .where(eq(clubMemberships.clubId, clubId)),
    db
      .select({
        openOre: sql<number>`coalesce(sum(${charges.amountOre}) filter (where ${charges.status} = 'open'), 0)::int`,
        openCount: sql<number>`count(*) filter (where ${charges.status} = 'open')::int`,
        overdueOre: sql<number>`coalesce(sum(${charges.amountOre}) filter (where ${charges.status} = 'open' and ${charges.dueDate} < ${today}), 0)::int`,
        overdueCount: sql<number>`count(*) filter (where ${charges.status} = 'open' and ${charges.dueDate} < ${today})::int`,
        paidYearOre: sql<number>`coalesce(sum(${charges.amountOre}) filter (where ${charges.status} = 'paid' and ${charges.paidAt} >= ${yearStart}::date), 0)::int`,
      })
      .from(charges)
      .where(eq(charges.clubId, clubId)),
    db.select({ name: clubs.name, stripeAccountId: clubs.stripeAccountId }).from(clubs).where(eq(clubs.id, clubId)),
  ]);
  return { clubName: club.name, paymentsConnected: !!club.stripeAccountId, members: m, charges: c };
}

async function loadCharge(db: Db, chargeId: string) {
  const [c] = await db.select().from(charges).where(eq(charges.id, chargeId));
  if (!c) throw new Error("Opkrævningen findes ikke");
  return c;
}

/** Kassereren registrerer en betaling, der er kommet uden om HoldLiv, fx kontant eller bankoverførsel. */
export async function registerManualPayment(db: Db, ctx: AccessContext, chargeId: string, note: string | null) {
  const charge = await loadCharge(db, chargeId);
  assertCan(ctx, { action: "finance.manage", clubId: charge.clubId });
  if (charge.status !== "open") throw new Error("Opkrævningen er ikke åben");
  await db.transaction(async (tx) => {
    await tx.insert(payments).values({
      chargeId,
      provider: "manual",
      amountOre: charge.amountOre,
      status: "succeeded",
      note,
      createdByUserId: ctx.userId,
      completedAt: ctx.now,
    });
    await tx.update(charges).set({ status: "paid", paidAt: ctx.now }).where(eq(charges.id, chargeId));
  });
  await logAudit(db, { action: "charge.manual_payment", clubId: charge.clubId, actorUserId: ctx.userId, targetType: "charge", targetId: chargeId, detail: { amountOre: charge.amountOre } });
}

export async function cancelCharge(db: Db, ctx: AccessContext, chargeId: string) {
  const charge = await loadCharge(db, chargeId);
  assertCan(ctx, { action: "finance.manage", clubId: charge.clubId });
  if (charge.status !== "open") throw new Error("Kun åbne opkrævninger kan annulleres");
  await db.update(charges).set({ status: "cancelled" }).where(eq(charges.id, chargeId));
  await logAudit(db, { action: "charge.cancelled", clubId: charge.clubId, actorUserId: ctx.userId, targetType: "charge", targetId: chargeId });
}

/** Refundering. Kortbetalinger sendes tilbage via Stripe; manuelle betalinger markeres blot som tilbagebetalt. */
export async function refundCharge(db: Db, ctx: AccessContext, chargeId: string, provider: PaymentProvider) {
  const charge = await loadCharge(db, chargeId);
  assertCan(ctx, { action: "finance.manage", clubId: charge.clubId });
  if (charge.status !== "paid") throw new Error("Kun betalte opkrævninger kan refunderes");
  const [payment] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.chargeId, chargeId), eq(payments.status, "succeeded")))
    .orderBy(desc(payments.completedAt))
    .limit(1);
  if (payment?.provider === "stripe") {
    const [club] = await db.select({ account: clubs.stripeAccountId }).from(clubs).where(eq(clubs.id, charge.clubId));
    if (!payment.providerPaymentId) throw new Error("Betalingen mangler Stripe-reference");
    await provider.refund(payment.providerPaymentId, club.account);
  }
  await db.transaction(async (tx) => {
    if (payment) await tx.update(payments).set({ status: "refunded", refundedAt: ctx.now }).where(eq(payments.id, payment.id));
    await tx.update(charges).set({ status: "refunded" }).where(eq(charges.id, chargeId));
  });
  await logAudit(db, { action: "charge.refunded", clubId: charge.clubId, actorUserId: ctx.userId, targetType: "charge", targetId: chargeId, detail: { amountOre: charge.amountOre } });
}

/** Hvem skal have besked om en opkrævning: forældrene for børn, ellers medlemmet selv. */
async function recipientsFor(db: Db, profileIds: string[], now: Date) {
  if (profileIds.length === 0) return new Map<string, string[]>();
  const [people, guardians] = await Promise.all([
    db
      .select({ id: profiles.id, birthDate: profiles.birthDate, email: profiles.email, userEmail: users.email })
      .from(profiles)
      .leftJoin(users, eq(users.id, profiles.userId))
      .where(inArray(profiles.id, profileIds)),
    db
      .select({ childId: guardianships.childProfileId, email: profiles.email, userEmail: users.email })
      .from(guardianships)
      .innerJoin(profiles, eq(profiles.id, guardianships.guardianProfileId))
      .leftJoin(users, eq(users.id, profiles.userId))
      .where(inArray(guardianships.childProfileId, profileIds)),
  ]);
  const out = new Map<string, string[]>();
  for (const p of people) {
    const list = isMinor(p.birthDate, now)
      ? guardians.filter((g) => g.childId === p.id).map((g) => g.userEmail ?? g.email)
      : [p.userEmail ?? p.email];
    out.set(p.id, [...new Set(list.filter((e): e is string => !!e))]);
  }
  return out;
}

export const REMINDER_INTERVAL_DAYS = 7;

/**
 * Sender rykker for forfaldne opkrævninger. Højst én rykker pr. opkrævning pr. uge,
 * så kassereren trygt kan trykke på knappen flere gange.
 */
export async function sendReminders(db: Db, ctx: AccessContext, clubId: string, mail: Mailer, baseUrl: string) {
  assertCan(ctx, { action: "finance.manage", clubId });
  const today = localDate(ctx.now);
  const since = new Date(ctx.now.getTime() - REMINDER_INTERVAL_DAYS * 86_400_000);
  const due = await db
    .select({
      id: charges.id,
      profileId: charges.profileId,
      firstName: profiles.firstName,
      description: charges.description,
      amountOre: charges.amountOre,
      dueDate: charges.dueDate,
      clubName: clubs.name,
    })
    .from(charges)
    .innerJoin(profiles, eq(profiles.id, charges.profileId))
    .innerJoin(clubs, eq(clubs.id, charges.clubId))
    .where(
      and(
        eq(charges.clubId, clubId),
        eq(charges.status, "open"),
        lt(charges.dueDate, today),
        or(isNull(charges.remindedAt), lt(charges.remindedAt, since)),
      ),
    );
  const recipients = await recipientsFor(db, [...new Set(due.map((d) => d.profileId))], ctx.now);
  let sent = 0;
  const unreachable: string[] = [];
  for (const c of due) {
    const to = recipients.get(c.profileId) ?? [];
    if (to.length === 0) {
      unreachable.push(c.firstName);
      continue;
    }
    const text = `Hej\n\nVi mangler betaling for ${c.firstName}: ${c.description}, ${kr(c.amountOre)}. Betalingsfristen var ${longDate(c.dueDate)}.\n\nDu kan betale her:\n${baseUrl}/betaling\n\nHar du allerede betalt, så se bort fra denne mail.\n\nVenlig hilsen\nKassereren, ${c.clubName}`;
    for (const email of to) await mail(email, `Påmindelse: kontingent for ${c.firstName}`, text);
    await db
      .update(charges)
      .set({ remindedAt: ctx.now, reminderCount: sql`${charges.reminderCount} + 1` })
      .where(eq(charges.id, c.id));
    sent++;
  }
  return { sent, unreachable };
}

// --- Medlemmets og forælderens side ---

/** Opkrævninger for login'et selv og dets børn. Åbne først. */
export async function listMyCharges(db: Db, ctx: AccessContext) {
  const ids = [ctx.profileId, ...ctx.wards];
  const today = localDate(ctx.now);
  const rows = await db
    .select({
      id: charges.id,
      profileId: charges.profileId,
      firstName: profiles.firstName,
      clubName: clubs.name,
      description: charges.description,
      amountOre: charges.amountOre,
      dueDate: charges.dueDate,
      status: charges.status,
      paidAt: charges.paidAt,
    })
    .from(charges)
    .innerJoin(profiles, eq(profiles.id, charges.profileId))
    .innerJoin(clubs, eq(clubs.id, charges.clubId))
    .where(and(inArray(charges.profileId, ids), ne(charges.status, "cancelled")))
    .orderBy(desc(charges.dueDate));
  const mapped = rows.map((r) => ({ ...r, isSelf: r.profileId === ctx.profileId, overdue: r.status === "open" && r.dueDate < today }));
  return { open: mapped.filter((r) => r.status === "open").reverse(), done: mapped.filter((r) => r.status !== "open") };
}

/** Starter en betaling og giver adressen, medlemmet skal sendes videre til. */
export async function startCheckout(db: Db, ctx: AccessContext, chargeId: string, provider: PaymentProvider, baseUrl: string) {
  const charge = await loadCharge(db, chargeId);
  assertCan(ctx, { action: "charge.pay", profileId: charge.profileId });
  if (charge.status !== "open") throw new Error("Opkrævningen er allerede betalt eller annulleret");
  const [[club], [me]] = await Promise.all([
    db.select({ name: clubs.name, account: clubs.stripeAccountId }).from(clubs).where(eq(clubs.id, charge.clubId)),
    db.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId)),
  ]);
  const session = await provider.createCheckout({
    chargeId,
    amountOre: charge.amountOre,
    description: `${club.name}: ${charge.description}`,
    customerEmail: me?.email,
    connectedAccountId: club.account,
    baseUrl,
  });
  await db.insert(payments).values({
    chargeId,
    provider: provider.name,
    providerRef: session.sessionId,
    amountOre: charge.amountOre,
    createdByUserId: ctx.userId,
  });
  return session.url;
}

/**
 * Bekræfter en betaling. Kaldes fra Stripes webhook (efter signaturtjek) eller fra testbetalingen.
 * Kan kaldes flere gange for samme betaling; kun første kald gør noget.
 */
export async function completeCheckout(
  db: Db,
  sessionId: string,
  opts: { paymentIntentId?: string | null; amountOre?: number | null; now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.providerRef, sessionId)).for("update");
    if (!payment) throw new Error("Ukendt betaling");
    if (payment.status !== "pending") return { chargeId: payment.chargeId, alreadyDone: true };
    if (opts.amountOre != null && opts.amountOre !== payment.amountOre) throw new Error("Det betalte beløb passer ikke med opkrævningen");
    await tx
      .update(payments)
      .set({ status: "succeeded", completedAt: now, providerPaymentId: opts.paymentIntentId ?? null })
      .where(eq(payments.id, payment.id));
    // Betalt to gange (fx i to faner): betalingen gemmes, og kassereren kan refundere den ene.
    await tx
      .update(charges)
      .set({ status: "paid", paidAt: now })
      .where(and(eq(charges.id, payment.chargeId), eq(charges.status, "open")));
    return { chargeId: payment.chargeId, alreadyDone: false };
  });
}

/** Testbetalingens side: hvad betales der for, og må login'et betale det. */
export async function getCheckout(db: Db, ctx: AccessContext, sessionId: string) {
  const [row] = await db
    .select({
      status: payments.status,
      amountOre: payments.amountOre,
      description: charges.description,
      profileId: charges.profileId,
      firstName: profiles.firstName,
      clubName: clubs.name,
    })
    .from(payments)
    .innerJoin(charges, eq(charges.id, payments.chargeId))
    .innerJoin(profiles, eq(profiles.id, charges.profileId))
    .innerJoin(clubs, eq(clubs.id, charges.clubId))
    .where(eq(payments.providerRef, sessionId));
  if (!row) throw new Error("Betalingen findes ikke");
  assertCan(ctx, { action: "charge.pay", profileId: row.profileId });
  return row;
}

/** Kobler foreningen til Stripe. Giver adressen til Stripes onboarding. */
export async function connectPayments(db: Db, ctx: AccessContext, clubId: string, provider: PaymentProvider, baseUrl: string) {
  assertCan(ctx, { action: "finance.manage", clubId });
  const [club] = await db.select({ account: clubs.stripeAccountId }).from(clubs).where(eq(clubs.id, clubId));
  const { accountId, url } = await provider.connectAccount(club.account, baseUrl);
  if (accountId !== club.account) await db.update(clubs).set({ stripeAccountId: accountId }).where(eq(clubs.id, clubId));
  return url;
}

export const canHandleFinance = (ctx: AccessContext, clubId: string) => can(ctx, { action: "finance.manage", clubId });
