// Udlæg og kørsel: et medlem (typisk en træner) lægger penge ud til foreningen eller kører for den og beder om at få dem tilbage.
//
// Regler:
//   - Beløb, og kilometersatsen til kørsel, bestemmer foreningens egen admin/kasserer. HoldLiv har ingen standardsats. Uden en sat
//     sats kan kørsel ikke indberettes. Satsen kopieres til kravet, så en senere ændring ikke rører gamle krav.
//   - Et udlæg skal have foto eller PDF af kvitteringen. Kørsel kan sendes uden bilag.
//   - Kun medlemmer af foreningen kan indsende, og kun for sig selv. Kravet kan trækkes tilbage, så længe det ikke er behandlet.
//   - Admin og kasserer godkender eller afviser (en afvisning skal have en begrundelse). Man kan ikke godkende sit eget krav, medmindre
//     man er den eneste admin/kasserer i foreningen. Udbetalingen sker uden for HoldLiv (bankoverførsel); her sættes kravet kun som betalt.
//   - Kvitteringen kan kun hentes af den, der har indsendt kravet, og af foreningens admin/kasserer.
//   - Godkendte og betalte krav gemmes uden navn, hvis personen sletter sin konto (bogføringsloven); resten slettes.
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubMemberships, clubRoles, clubs, expenseClaims, expenseReceipts, profiles, teamMembers, teams, users } from "../db/schema";
import { assertCan, ForbiddenError, type AccessContext } from "../auth/permissions";
import { kr, localDate } from "../lib/money";
import { logAudit } from "./audit";
import { csvCell } from "./finance";
import { notifyUsers, type Deliver } from "./notifications";

/** 50.000 kr. i øre: en teknisk øvre grænse mod tastefejl. */
export const MAX_EXPENSE_ORE = 5_000_000;
export const MAX_KM_TENTHS = 10_000;
export const MAX_RECEIPT_BYTES = 6 * 1024 * 1024;
/** Hvor langt tilbage en udgift kan ligge. */
const MAX_AGE_DAYS = 365;

export type ExpenseStatus = "submitted" | "approved" | "rejected" | "paid" | "cancelled";
export const EXPENSE_STATUS_LABEL: Record<ExpenseStatus, string> = {
  submitted: "Afventer godkendelse",
  approved: "Godkendt, ikke betalt",
  rejected: "Afvist",
  paid: "Betalt",
  cancelled: "Trukket tilbage",
};

/** Finder filtypen ud fra filens første bytes, ikke ud fra det, browseren hævder. */
export function sniffReceipt(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | "application/pdf" | null {
  const at = (i: number, ...b: number[]) => b.every((v, k) => bytes[i + k] === v);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x25, 0x50, 0x44, 0x46, 0x2d)) return "application/pdf";
  return null;
}

/** Foreningens kilometersats i øre pr. km. Tom = kørsel kan ikke indberettes. */
export async function setMileageRate(db: Db, ctx: AccessContext, clubId: string, rateOre: number | null) {
  assertCan(ctx, { action: "finance.manage", clubId });
  if (rateOre !== null && (!Number.isInteger(rateOre) || rateOre < 1 || rateOre > 10_000)) throw new Error("Satsen skal være mellem 0,01 og 100 kr. pr. km.");
  await db.update(clubs).set({ mileageRateOrePerKm: rateOre }).where(eq(clubs.id, clubId));
  await logAudit(db, { action: "club.mileage_rate", clubId, actorUserId: ctx.userId, detail: { rateOre } });
}

export async function getMileageRate(db: Db, clubId: string) {
  const [c] = await db.select({ rate: clubs.mileageRateOrePerKm }).from(clubs).where(eq(clubs.id, clubId));
  return c?.rate ?? null;
}

async function financeRecipients(db: Db, clubId: string, exceptProfileId?: string) {
  const rows = await db
    .select({ userId: users.id, email: users.email, phone: profiles.phone, profileId: profiles.id })
    .from(clubRoles)
    .innerJoin(profiles, eq(profiles.id, clubRoles.profileId))
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(eq(clubRoles.clubId, clubId), inArray(clubRoles.role, ["admin", "treasurer"])));
  const seen = new Set<string>();
  return rows.filter((r) => r.profileId !== exceptProfileId && !seen.has(r.userId) && !!seen.add(r.userId));
}

async function claimantRecipient(db: Db, profileId: string) {
  const [r] = await db
    .select({ userId: users.id, email: users.email, phone: profiles.phone })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(eq(profiles.id, profileId));
  return r ? [r] : [];
}

export interface ExpenseInput {
  kind: "expense" | "mileage";
  description: string;
  spentOn: string;
  teamId?: string | null;
  /** Udlæg: beløbet i øre. */
  amountOre?: number;
  /** Kørsel: antal kilometer. */
  km?: number;
  receipt?: { bytes: Uint8Array } | null;
}

/** Indsender et udlæg eller en kørsel for sig selv. */
export async function submitExpense(db: Db, ctx: AccessContext, clubId: string, input: ExpenseInput, deliver?: Deliver) {
  const [m] = await db
    .select({ p: clubMemberships.profileId })
    .from(clubMemberships)
    .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.profileId, ctx.profileId)));
  if (!m) throw new ForbiddenError("club.view");
  const description = input.description.trim();
  if (!description) throw new Error("Skriv, hvad udgiften er til.");
  if (description.length > 200) throw new Error("Beskrivelsen må højst være på 200 tegn.");
  const today = localDate(ctx.now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.spentOn) || Number.isNaN(Date.parse(input.spentOn))) throw new Error("Vælg en dato.");
  if (input.spentOn > today) throw new Error("Datoen kan ikke ligge i fremtiden.");
  if (Date.parse(today) - Date.parse(input.spentOn) > MAX_AGE_DAYS * 86_400_000) throw new Error("Udgifter ældre end et år kan ikke indsendes.");
  if (input.teamId) {
    const [t] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, input.teamId), eq(teams.clubId, clubId)));
    if (!t) throw new Error("Holdet findes ikke i foreningen.");
  }

  let amountOre: number;
  let kmTenths: number | null = null;
  let rate: number | null = null;
  if (input.kind === "mileage") {
    rate = await getMileageRate(db, clubId);
    if (!rate) throw new Error("Foreningen har ikke sat en kilometersats, så kørsel kan ikke indberettes endnu.");
    kmTenths = Math.round((input.km ?? 0) * 10);
    if (!Number.isFinite(kmTenths) || kmTenths < 1 || kmTenths > MAX_KM_TENTHS) throw new Error("Skriv antal kilometer (mellem 0,1 og 1.000).");
    amountOre = Math.round((kmTenths * rate) / 10);
  } else {
    amountOre = input.amountOre ?? 0;
    if (!Number.isInteger(amountOre) || amountOre < 1 || amountOre > MAX_EXPENSE_ORE) throw new Error("Beløbet skal være mellem 0,01 og 50.000 kr.");
    if (!input.receipt) throw new Error("Vedhæft et foto eller en PDF af kvitteringen.");
  }
  let contentType: ReturnType<typeof sniffReceipt> = null;
  if (input.receipt) {
    if (input.receipt.bytes.length > MAX_RECEIPT_BYTES) throw new Error("Kvitteringen må højst fylde 6 MB.");
    contentType = sniffReceipt(input.receipt.bytes);
    if (!contentType) throw new Error("Kvitteringen skal være et foto (JPG, PNG, WebP) eller en PDF.");
  }

  const claim = await db.transaction(async (tx) => {
    const [c] = await tx
      .insert(expenseClaims)
      .values({ clubId, profileId: ctx.profileId, teamId: input.teamId ?? null, kind: input.kind, description, amountOre, kmTenths, rateOrePerKm: rate, spentOn: input.spentOn })
      .returning();
    if (input.receipt && contentType) {
      await tx.insert(expenseReceipts).values({ claimId: c.id, contentType, size: input.receipt.bytes.length, data: Buffer.from(input.receipt.bytes) });
    }
    return c;
  });
  await logAudit(db, { action: "expense.submitted", clubId, actorUserId: ctx.userId, targetType: "expense", targetId: claim.id, detail: { kind: input.kind, amountOre } });
  if (deliver) {
    const [me] = await db.select({ firstName: profiles.firstName, lastName: profiles.lastName }).from(profiles).where(eq(profiles.id, ctx.profileId));
    await notifyUsers(db, deliver, await financeRecipients(db, clubId, ctx.profileId), {
      kind: "expense",
      subject: `Nyt udlæg til godkendelse: ${kr(amountOre)}`,
      body: `${me.firstName} ${me.lastName} har indsendt ${input.kind === "mileage" ? "kørsel" : "et udlæg"} på ${kr(amountOre)}: ${description}.\n\nBehandl det her: ${deliver.baseUrl}/kasse/udlaeg?klub=${clubId}`,
      sms: `Nyt udlæg på ${kr(amountOre)} venter på godkendelse i HoldLiv.`,
      url: `/kasse/udlaeg?klub=${clubId}`,
      dedupeKey: `expense:${claim.id}:new`,
    });
  }
  return claim;
}

/** Egne krav, nyeste først. */
export async function listMyExpenses(db: Db, ctx: AccessContext) {
  const rows = await db
    .select({ claim: expenseClaims, clubName: clubs.name, receiptId: expenseReceipts.id })
    .from(expenseClaims)
    .innerJoin(clubs, eq(clubs.id, expenseClaims.clubId))
    .leftJoin(expenseReceipts, eq(expenseReceipts.claimId, expenseClaims.id))
    .where(eq(expenseClaims.profileId, ctx.profileId))
    .orderBy(desc(expenseClaims.createdAt));
  return rows.map((r) => ({ ...r.claim, clubName: r.clubName, hasReceipt: !!r.receiptId }));
}

/** Foreningerne, man er medlem af, og deres kilometersats. Bruges til at vise formularen. */
export async function expenseClubs(db: Db, ctx: AccessContext) {
  return db
    .select({ id: clubs.id, name: clubs.name, mileageRateOrePerKm: clubs.mileageRateOrePerKm })
    .from(clubMemberships)
    .innerJoin(clubs, eq(clubs.id, clubMemberships.clubId))
    .where(eq(clubMemberships.profileId, ctx.profileId))
    .orderBy(asc(clubs.name));
}

/** Hold, et krav kan knyttes til: de hold, man selv er på, og alle foreningens hold for admin. */
export async function expenseTeams(db: Db, ctx: AccessContext) {
  const own = await db
    .select({ id: teams.id, name: teams.name, clubId: teams.clubId })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.profileId, ctx.profileId));
  const adminTeams = ctx.adminClubs.size ? await db.select({ id: teams.id, name: teams.name, clubId: teams.clubId }).from(teams).where(inArray(teams.clubId, [...ctx.adminClubs])) : [];
  const seen = new Set<string>();
  return [...own, ...adminTeams].filter((t) => !seen.has(t.id) && !!seen.add(t.id)).sort((a, b) => a.name.localeCompare(b.name, "da"));
}

async function loadClaim(db: Pick<Db, "select">, claimId: string) {
  const [c] = await db.select().from(expenseClaims).where(eq(expenseClaims.id, claimId));
  if (!c) throw new Error("Kravet findes ikke");
  return c;
}

/** Trækker et krav tilbage, så længe ingen har behandlet det. */
export async function cancelExpense(db: Db, ctx: AccessContext, claimId: string) {
  const c = await loadClaim(db, claimId);
  if (c.profileId !== ctx.profileId) throw new ForbiddenError("club.view");
  const done = await db.update(expenseClaims).set({ status: "cancelled" }).where(and(eq(expenseClaims.id, claimId), eq(expenseClaims.status, "submitted"))).returning({ id: expenseClaims.id });
  if (done.length === 0) throw new Error("Kravet er allerede behandlet og kan ikke trækkes tilbage.");
  await db.delete(expenseReceipts).where(eq(expenseReceipts.claimId, claimId));
  await logAudit(db, { action: "expense.cancelled", clubId: c.clubId, actorUserId: ctx.userId, targetType: "expense", targetId: claimId });
}

export type ExpenseFilter = "open" | "unpaid" | "paid" | "all";

/** Foreningens krav til kassereren. */
export async function listExpenses(db: Db, ctx: AccessContext, clubId: string, filter: ExpenseFilter = "open") {
  assertCan(ctx, { action: "finance.manage", clubId });
  const status: Record<ExpenseFilter, ExpenseStatus[] | null> = { open: ["submitted"], unpaid: ["approved"], paid: ["paid"], all: null };
  const rows = await db
    .select({ claim: expenseClaims, firstName: profiles.firstName, lastName: profiles.lastName, teamName: teams.name, receiptId: expenseReceipts.id })
    .from(expenseClaims)
    .innerJoin(profiles, eq(profiles.id, expenseClaims.profileId))
    .leftJoin(teams, eq(teams.id, expenseClaims.teamId))
    .leftJoin(expenseReceipts, eq(expenseReceipts.claimId, expenseClaims.id))
    .where(and(eq(expenseClaims.clubId, clubId), status[filter] ? inArray(expenseClaims.status, status[filter]!) : ne(expenseClaims.status, "cancelled")))
    .orderBy(asc(expenseClaims.createdAt));
  return rows.map((r) => ({ ...r.claim, firstName: r.firstName, lastName: r.lastName, teamName: r.teamName, hasReceipt: !!r.receiptId, own: r.claim.profileId === ctx.profileId }));
}

/** Godkender eller afviser et krav. */
export async function decideExpense(db: Db, ctx: AccessContext, claimId: string, decision: "approve" | "reject", reason: string | null, deliver?: Deliver) {
  const c = await loadClaim(db, claimId);
  assertCan(ctx, { action: "finance.manage", clubId: c.clubId });
  if (decision === "reject" && !reason?.trim()) throw new Error("Skriv en begrundelse, så medlemmet ved hvorfor.");
  if (c.profileId === ctx.profileId && (await financeRecipients(db, c.clubId, ctx.profileId)).length > 0) {
    throw new Error("Du kan ikke godkende dit eget krav. Bed en anden admin eller kasserer om det.");
  }
  const now = ctx.now;
  const done = await db
    .update(expenseClaims)
    .set({ status: decision === "approve" ? "approved" : "rejected", decidedAt: now, decidedByUserId: ctx.userId, rejectReason: decision === "reject" ? reason!.trim() : null })
    .where(and(eq(expenseClaims.id, claimId), eq(expenseClaims.status, "submitted")))
    .returning({ id: expenseClaims.id });
  if (done.length === 0) throw new Error("Kravet er allerede behandlet.");
  await logAudit(db, { action: decision === "approve" ? "expense.approved" : "expense.rejected", clubId: c.clubId, actorUserId: ctx.userId, targetType: "expense", targetId: claimId });
  if (deliver) {
    await notifyUsers(db, deliver, await claimantRecipient(db, c.profileId), {
      kind: "expense",
      subject: decision === "approve" ? `Dit udlæg på ${kr(c.amountOre)} er godkendt` : `Dit udlæg på ${kr(c.amountOre)} er afvist`,
      body:
        decision === "approve"
          ? `Dit krav (${c.description}) på ${kr(c.amountOre)} er godkendt. Du får besked, når beløbet er betalt.\n\nSe det her: ${deliver.baseUrl}/udlaeg`
          : `Dit krav (${c.description}) på ${kr(c.amountOre)} er afvist.\n\nBegrundelse: ${reason!.trim()}\n\nSe det her: ${deliver.baseUrl}/udlaeg`,
      sms: decision === "approve" ? `Dit udlæg på ${kr(c.amountOre)} er godkendt.` : `Dit udlæg på ${kr(c.amountOre)} er afvist. Se begrundelsen i HoldLiv.`,
      url: "/udlaeg",
      dedupeKey: `expense:${claimId}:${decision}`,
    });
  }
}

/** Registrerer, at et godkendt krav er betalt ud (fx ved bankoverførsel). */
export async function markExpensePaid(db: Db, ctx: AccessContext, claimId: string, note: string | null, deliver?: Deliver) {
  const c = await loadClaim(db, claimId);
  assertCan(ctx, { action: "finance.manage", clubId: c.clubId });
  const done = await db
    .update(expenseClaims)
    .set({ status: "paid", paidAt: ctx.now, paidByUserId: ctx.userId, payNote: note?.trim() || null })
    .where(and(eq(expenseClaims.id, claimId), eq(expenseClaims.status, "approved")))
    .returning({ id: expenseClaims.id });
  if (done.length === 0) throw new Error("Kun godkendte krav kan sættes som betalt.");
  await logAudit(db, { action: "expense.paid", clubId: c.clubId, actorUserId: ctx.userId, targetType: "expense", targetId: claimId });
  if (deliver) {
    await notifyUsers(db, deliver, await claimantRecipient(db, c.profileId), {
      kind: "expense",
      subject: `Dit udlæg på ${kr(c.amountOre)} er betalt`,
      body: `${kr(c.amountOre)} for ${c.description} er betalt til dig.\n\nSe det her: ${deliver.baseUrl}/udlaeg`,
      sms: `${kr(c.amountOre)} for dit udlæg er betalt.`,
      url: "/udlaeg",
      dedupeKey: `expense:${claimId}:paid`,
    });
  }
}

/** Kvitteringen. Kun den, der har indsendt kravet, og foreningens admin/kasserer. */
export async function getExpenseReceipt(db: Db, ctx: AccessContext, claimId: string) {
  const c = await loadClaim(db, claimId);
  if (c.profileId !== ctx.profileId) assertCan(ctx, { action: "finance.manage", clubId: c.clubId });
  const [r] = await db.select().from(expenseReceipts).where(eq(expenseReceipts.claimId, claimId));
  if (!r) throw new Error("Kravet har ingen kvittering");
  return { contentType: r.contentType, data: r.data };
}

/** Godkendte, ikke betalte krav som regneark til bankoverførsel. */
export async function expensesCsv(db: Db, ctx: AccessContext, clubId: string) {
  const rows = await listExpenses(db, ctx, clubId, "unpaid");
  await logAudit(db, { action: "expense.exported", clubId, actorUserId: ctx.userId, detail: { rows: rows.length } });
  const lines = rows.map((r) =>
    [`${r.firstName} ${r.lastName}`, r.description, r.kind === "mileage" ? "Kørsel" : "Udlæg", r.spentOn, (r.amountOre / 100).toFixed(2).replace(".", ","), r.id.slice(0, 8).toUpperCase()].map(csvCell).join(";"),
  );
  return "﻿" + [["Navn", "Beskrivelse", "Type", "Dato", "Beløb (kr.)", "Bilagsnr."].join(";"), ...lines].join("\r\n") + "\r\n";
}
