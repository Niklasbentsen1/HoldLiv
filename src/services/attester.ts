// Børneattester: sporing af, hvem der skal have en, om der er givet samtykke, om foreningen har hentet den, og hvornår den udløber.
//
// Regler:
//   - HoldLiv gemmer hverken selve attesten, CPR-nummer eller en eventuel anmærkning. Kun status, datoer og samtykke.
//   - Selve indhentningen sker i Politiets/virk-løsningen med foreningens eget login. Her registrerer admin, at den er bestilt og hvad svaret blev.
//   - Foreningen må først bestille en attest, når personen (eller en værge, hvis personen er under 18) har sagt ja. Samtykket gives i HoldLiv,
//     eller foreningen registrerer, at den har et skriftligt samtykke.
//   - Udløbsdatoen sætter foreningen selv. Før den udløber, får administratorerne en påmindelse.
//   - Kun foreningens administratorer ser listen. Personen selv (og en værge) ser sin egen status.
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { childCertificates, clubMemberships, clubRoles, profiles, shiftSignups, teamMembers, teams, users, volunteerShifts } from "../db/schema";
import { assertCan, isMinor, type AccessContext } from "../auth/permissions";
import { addDays, localDate, longDate } from "../lib/money";
import { logAudit } from "./audit";
import { notifyUsers, recipientsOfPlayers, type Deliver, type Recipient } from "./notifications";

/** Dage før udløb, hvor påmindelserne begynder. */
export const EXPIRY_WARNING_DAYS = 60;
/** Dage, en attest må stå som "mangler" eller "bestilt", før administratorerne mindes om den. */
export const STALE_DAYS = 14;
const MAX_VALIDITY_YEARS = 10;

export type CertificateState = "no_consent" | "ready_to_request" | "requested" | "valid" | "expiring" | "expired" | "not_approved";

export const CERTIFICATE_STATE_LABEL: Record<CertificateState, string> = {
  no_consent: "Mangler samtykke",
  ready_to_request: "Klar til bestilling",
  requested: "Bestilt, afventer svar",
  valid: "Gyldig",
  expiring: "Udløber snart",
  expired: "Udløbet",
  not_approved: "Ikke godkendt",
};

type Row = typeof childCertificates.$inferSelect;

/** Attestens tilstand på en given dag ("ÅÅÅÅ-MM-DD"). */
export function certificateState(c: Pick<Row, "status" | "consentAt" | "expiresOn">, today: string): CertificateState {
  if (c.status === "not_approved") return "not_approved";
  if (c.status === "approved") {
    if (!c.expiresOn || c.expiresOn <= today) return "expired";
    return c.expiresOn <= addDays(today, EXPIRY_WARNING_DAYS) ? "expiring" : "valid";
  }
  if (c.status === "requested") return "requested";
  return c.consentAt ? "ready_to_request" : "no_consent";
}

/** Den, der må give samtykke eller underskrive for en person: en voksen selv, ellers en værge. */
export async function assertSigner(db: Pick<Db, "select">, ctx: AccessContext, profileId: string) {
  const [p] = await db.select({ firstName: profiles.firstName, lastName: profiles.lastName, birthDate: profiles.birthDate }).from(profiles).where(eq(profiles.id, profileId));
  if (!p) throw new Error("Personen findes ikke.");
  const minor = p.birthDate !== null && isMinor(p.birthDate, ctx.now);
  const allowed = minor ? ctx.wards.has(profileId) : profileId === ctx.profileId || (p.birthDate === null && ctx.wards.has(profileId));
  if (!allowed) throw new Error(minor ? "Personen er under 18 år, så en værge skal svare." : "Kun personen selv kan svare.");
  const [me] = await db.select({ firstName: profiles.firstName, lastName: profiles.lastName }).from(profiles).where(eq(profiles.id, ctx.profileId));
  return { signerName: `${me.firstName} ${me.lastName}`, personName: `${p.firstName} ${p.lastName}` };
}

export async function adminRecipients(db: Db, clubId: string): Promise<Recipient[]> {
  const rows = await db
    .select({ userId: users.id, email: users.email, phone: profiles.phone })
    .from(clubRoles)
    .innerJoin(profiles, eq(profiles.id, clubRoles.profileId))
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(eq(clubRoles.clubId, clubId), eq(clubRoles.role, "admin")));
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.userId) && !!seen.add(r.userId));
}

async function load(db: Pick<Db, "select">, id: string) {
  const [c] = await db.select().from(childCertificates).where(eq(childCertificates.id, id));
  if (!c) throw new Error("Attesten findes ikke.");
  return c;
}

/** Medlem af foreningen eller på et af dens hold. */
export async function belongsToClub(db: Pick<Db, "select">, clubId: string, profileId: string) {
  const [m] = await db
    .select({ id: clubMemberships.profileId })
    .from(clubMemberships)
    .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.profileId, profileId)));
  if (m) return true;
  const [t] = await db
    .select({ id: teamMembers.profileId })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teams.clubId, clubId), eq(teamMembers.profileId, profileId)));
  return !!t;
}

/** Foreningen markerer, at en person skal have en børneattest. Er den udløbet eller ikke godkendt, starter forløbet forfra. */
export async function requireCertificate(db: Db, ctx: AccessContext, clubId: string, profileId: string, reason?: string | null) {
  assertCan(ctx, { action: "club.manage", clubId });
  if (!(await belongsToClub(db, clubId, profileId))) throw new Error("Personen hører ikke til foreningen.");
  const cleanReason = reason?.trim().slice(0, 200) || null;
  const today = localDate(ctx.now);
  const [existing] = await db.select().from(childCertificates).where(and(eq(childCertificates.clubId, clubId), eq(childCertificates.profileId, profileId)));
  if (existing) {
    const state = certificateState(existing, today);
    if (state === "valid" || state === "expiring") throw new Error("Personen har allerede en gyldig børneattest.");
    if (state !== "expired" && state !== "not_approved") throw new Error("Attesten er allerede i gang.");
    // Nyt forløb: samtykket gælder for den gamle attest, så det skal gives igen.
    await db
      .update(childCertificates)
      .set({ status: "needed", reason: cleanReason ?? existing.reason, consentAt: null, consentByUserId: null, consentMethod: null, requestedAt: null, decidedAt: null, issuedOn: null, expiresOn: null, lastReminderKey: null })
      .where(eq(childCertificates.id, existing.id));
    await logAudit(db, { action: "certificate.renewal_started", clubId, actorUserId: ctx.userId, targetType: "child_certificate", targetId: existing.id });
    return existing.id;
  }
  const [c] = await db.insert(childCertificates).values({ clubId, profileId, reason: cleanReason, registeredByUserId: ctx.userId }).returning({ id: childCertificates.id });
  await logAudit(db, { action: "certificate.required", clubId, actorUserId: ctx.userId, targetType: "child_certificate", targetId: c.id });
  return c.id;
}

/** Personen (eller en værge for en under 18) siger ja til, at foreningen henter en børneattest. */
export async function giveCertificateConsent(db: Db, ctx: AccessContext, certificateId: string) {
  const c = await load(db, certificateId);
  await assertSigner(db, ctx, c.profileId);
  const done = await db
    .update(childCertificates)
    .set({ consentAt: ctx.now, consentByUserId: ctx.userId, consentMethod: "app" })
    .where(and(eq(childCertificates.id, certificateId), eq(childCertificates.status, "needed"), isNull(childCertificates.consentAt)))
    .returning({ id: childCertificates.id });
  if (done.length === 0) throw new Error("Der er allerede givet samtykke.");
  await logAudit(db, { action: "certificate.consent_given", clubId: c.clubId, actorUserId: ctx.userId, targetType: "child_certificate", targetId: certificateId });
}

/** Foreningen har et skriftligt samtykke og registrerer det. */
export async function recordWrittenConsent(db: Db, ctx: AccessContext, certificateId: string) {
  const c = await load(db, certificateId);
  assertCan(ctx, { action: "club.manage", clubId: c.clubId });
  const done = await db
    .update(childCertificates)
    .set({ consentAt: ctx.now, consentByUserId: ctx.userId, consentMethod: "written" })
    .where(and(eq(childCertificates.id, certificateId), eq(childCertificates.status, "needed"), isNull(childCertificates.consentAt)))
    .returning({ id: childCertificates.id });
  if (done.length === 0) throw new Error("Der er allerede givet samtykke.");
  await logAudit(db, { action: "certificate.written_consent_recorded", clubId: c.clubId, actorUserId: ctx.userId, targetType: "child_certificate", targetId: certificateId });
}

/** Foreningen har bestilt attesten i Politiets løsning. Kræver samtykke. */
export async function markCertificateRequested(db: Db, ctx: AccessContext, certificateId: string) {
  const c = await load(db, certificateId);
  assertCan(ctx, { action: "club.manage", clubId: c.clubId });
  if (c.status !== "needed") throw new Error("Attesten er allerede bestilt eller afgjort.");
  if (!c.consentAt) throw new Error("Personen skal først give samtykke, før attesten kan bestilles.");
  const done = await db.update(childCertificates).set({ status: "requested", requestedAt: ctx.now }).where(and(eq(childCertificates.id, certificateId), eq(childCertificates.status, "needed"))).returning({ id: childCertificates.id });
  if (done.length === 0) throw new Error("Attesten er allerede bestilt eller afgjort.");
  await logAudit(db, { action: "certificate.requested", clubId: c.clubId, actorUserId: ctx.userId, targetType: "child_certificate", targetId: certificateId });
}

export interface CertificateResult {
  approved: boolean;
  /** Attestens dato ("ÅÅÅÅ-MM-DD"). */
  issuedOn?: string | null;
  /** Hvornår foreningen vil have en ny, bestemt af foreningen selv. */
  expiresOn?: string | null;
}

const isDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Foreningen registrerer svaret: godkendt (med udløbsdato) eller ikke godkendt. Anmærkningens indhold gemmes ikke. */
export async function registerCertificateResult(db: Db, ctx: AccessContext, certificateId: string, result: CertificateResult) {
  const c = await load(db, certificateId);
  assertCan(ctx, { action: "club.manage", clubId: c.clubId });
  if (c.status !== "requested") throw new Error("Attesten skal først være bestilt.");
  let issuedOn: string | null = null;
  let expiresOn: string | null = null;
  if (result.approved) {
    issuedOn = result.issuedOn ?? null;
    expiresOn = result.expiresOn ?? null;
    if (!isDate(issuedOn)) throw new Error("Skriv attestens dato.");
    if (!isDate(expiresOn)) throw new Error("Skriv, hvornår foreningen vil have en ny attest.");
    if (issuedOn > localDate(ctx.now)) throw new Error("Attestens dato ligger i fremtiden.");
    if (expiresOn <= issuedOn) throw new Error("Udløbsdatoen skal ligge efter attestens dato.");
    if (expiresOn > addDays(issuedOn, 366 * MAX_VALIDITY_YEARS)) throw new Error(`Udløbsdatoen må højst ligge ${MAX_VALIDITY_YEARS} år efter attestens dato.`);
  }
  const done = await db
    .update(childCertificates)
    .set({ status: result.approved ? "approved" : "not_approved", decidedAt: ctx.now, issuedOn, expiresOn, lastReminderKey: null, registeredByUserId: ctx.userId })
    .where(and(eq(childCertificates.id, certificateId), eq(childCertificates.status, "requested")))
    .returning({ id: childCertificates.id });
  if (done.length === 0) throw new Error("Attesten skal først være bestilt.");
  await logAudit(db, { action: "certificate.decided", clubId: c.clubId, actorUserId: ctx.userId, targetType: "child_certificate", targetId: certificateId, detail: { approved: result.approved } });
}

/** Fjerner sporingen (fx hvis personen ikke længere skal bruge en attest). */
export async function removeCertificate(db: Db, ctx: AccessContext, certificateId: string) {
  const c = await load(db, certificateId);
  assertCan(ctx, { action: "club.manage", clubId: c.clubId });
  await db.delete(childCertificates).where(eq(childCertificates.id, certificateId));
  await logAudit(db, { action: "certificate.removed", clubId: c.clubId, actorUserId: ctx.userId, targetType: "child_certificate", targetId: certificateId });
}

/** Har personen en godkendt, ikke-udløbet attest på den givne dag? */
export async function hasValidCertificate(db: Pick<Db, "select">, clubId: string, profileId: string, on: Date) {
  const day = localDate(on);
  const [c] = await db
    .select({ id: childCertificates.id })
    .from(childCertificates)
    .where(and(eq(childCertificates.clubId, clubId), eq(childCertificates.profileId, profileId), eq(childCertificates.status, "approved"), gt(childCertificates.expiresOn, day)));
  return !!c;
}

/** Alle attester i foreningen med navne og tilstand. De mest presserende (udløbet, mangler samtykke) står øverst. Kun admin. */
export async function listClubCertificates(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  const rows = await db
    .select({ c: childCertificates, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(childCertificates)
    .innerJoin(profiles, eq(profiles.id, childCertificates.profileId))
    .where(eq(childCertificates.clubId, clubId))
    .orderBy(asc(profiles.firstName), asc(profiles.lastName));
  const today = localDate(ctx.now);
  const order: Record<CertificateState, number> = { expired: 0, not_approved: 1, no_consent: 2, ready_to_request: 3, requested: 4, expiring: 5, valid: 6 };
  return rows
    .map(({ c, firstName, lastName }) => ({ ...c, name: `${firstName} ${lastName}`, state: certificateState(c, today) }))
    .sort((a, b) => order[a.state] - order[b.state]);
}

/** Personer, der bør have en attest, men ikke har en gyldig eller igangværende: foreningens trænere og dem på kommende vagter, der kræver attest. Kun admin. */
export async function listCertificateGaps(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  const today = localDate(ctx.now);
  const coaches = await db
    .select({ profileId: teamMembers.profileId, team: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teams.clubId, clubId), eq(teamMembers.role, "coach")));
  const shiftPeople = await db
    .select({ profileId: shiftSignups.profileId, title: volunteerShifts.title })
    .from(shiftSignups)
    .innerJoin(volunteerShifts, eq(volunteerShifts.id, shiftSignups.shiftId))
    .where(and(eq(volunteerShifts.clubId, clubId), eq(volunteerShifts.requiresChildCertificate, true), isNull(volunteerShifts.cancelledAt), isNull(shiftSignups.cancelledAt), gt(volunteerShifts.endsAt, ctx.now)));
  const reasons = new Map<string, Set<string>>();
  const add = (id: string, why: string) => reasons.set(id, (reasons.get(id) ?? new Set<string>()).add(why));
  for (const c of coaches) add(c.profileId, `Træner ${c.team}`);
  for (const s of shiftPeople) add(s.profileId, `Vagt: ${s.title}`);
  if (reasons.size === 0) return [];
  const ids = [...reasons.keys()];
  const certs = await db.select().from(childCertificates).where(and(eq(childCertificates.clubId, clubId), inArray(childCertificates.profileId, ids)));
  const covered = new Set(certs.filter((c) => !["expired", "not_approved"].includes(certificateState(c, today))).map((c) => c.profileId));
  const missing = ids.filter((id) => !covered.has(id));
  if (missing.length === 0) return [];
  const names = await db.select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName }).from(profiles).where(inArray(profiles.id, missing));
  return names
    .map((n) => ({ profileId: n.id, name: `${n.firstName} ${n.lastName}`, reason: [...reasons.get(n.id)!].join(", "), expired: certs.some((c) => c.profileId === n.id) }))
    .sort((a, b) => a.name.localeCompare(b.name, "da"));
}

/** Egne og børns attester, så personen kan give samtykke og følge med. */
export async function listMyCertificates(db: Db, ctx: AccessContext) {
  const people = [ctx.profileId, ...ctx.wards];
  const rows = await db
    .select({ c: childCertificates, firstName: profiles.firstName, birthDate: profiles.birthDate, club: sql<string>`(select name from clubs where clubs.id = ${childCertificates.clubId})` })
    .from(childCertificates)
    .innerJoin(profiles, eq(profiles.id, childCertificates.profileId))
    .where(inArray(childCertificates.profileId, people));
  const today = localDate(ctx.now);
  return rows.map(({ c, firstName, club, birthDate }) => {
    const minor = birthDate !== null && isMinor(birthDate, ctx.now);
    const mayConsent = c.profileId === ctx.profileId ? !minor : ctx.wards.has(c.profileId);
    return { id: c.id, club, firstName, self: c.profileId === ctx.profileId, reason: c.reason, state: certificateState(c, today), expiresOn: c.expiresOn, canConsent: c.status === "needed" && !c.consentAt && mayConsent };
  });
}

/**
 * Påmindelser. Kan køres så ofte, man vil: hver besked sendes højst én gang pr. uge.
 *   - Personen (eller værgen), der mangler at give samtykke, får en påmindelse efter 3 dage og derefter hver uge.
 *   - Administratorerne får besked om attester, der udløber inden 60 dage, er udløbet, eller har ventet mere end 14 dage på samtykke, bestilling eller svar.
 */
export async function sendCertificateReminders(db: Db, deliver: Deliver, now = new Date()) {
  const today = localDate(now);
  const week = `w${Math.floor((Date.parse(`${today}T00:00:00Z`) / 86400000 + 3) / 7)}`;
  const rows = await db
    .select({ c: childCertificates, firstName: profiles.firstName, lastName: profiles.lastName, club: sql<string>`(select name from clubs where clubs.id = ${childCertificates.clubId})` })
    .from(childCertificates)
    .innerJoin(profiles, eq(profiles.id, childCertificates.profileId));
  let personal = 0;
  const perClub = new Map<string, { club: string; lines: string[] }>();
  for (const { c, firstName, lastName, club } of rows) {
    const state = certificateState(c, today);
    const ageDays = (now.getTime() - c.createdAt.getTime()) / 86400000;
    if (state === "no_consent" && ageDays >= 3 && c.lastReminderKey !== week) {
      const to = await recipientsOfPlayers(db, [c.profileId], now);
      const res = await notifyUsers(db, deliver, to, {
        kind: "volunteer",
        subject: `${club} beder om samtykke til en børneattest`,
        body: `${club} skal bruge en børneattest på ${firstName}. Foreningen må først bestille den, når der er sagt ja. Du kan give samtykke under Vagter og attester i HoldLiv.`,
        sms: `${club} mangler samtykke til børneattest for ${firstName}.`,
        url: "/vagtplan",
        dedupeKey: `cert-consent:${c.id}:${week}`,
      });
      personal += res.sent;
      await db.update(childCertificates).set({ lastReminderKey: week }).where(eq(childCertificates.id, c.id));
    }
    let line: string | null = null;
    if (state === "expired") line = `${firstName} ${lastName}: attesten er udløbet`;
    else if (state === "expiring") line = `${firstName} ${lastName}: attesten udløber ${longDate(c.expiresOn!)}`;
    else if ((state === "no_consent" || state === "ready_to_request" || state === "requested") && ageDays >= STALE_DAYS) {
      line = `${firstName} ${lastName}: ${state === "no_consent" ? "mangler samtykke" : state === "ready_to_request" ? "skal bestilles" : "venter på svar"} siden ${longDate(localDate(c.requestedAt ?? c.createdAt))}`;
    }
    if (line) (perClub.get(c.clubId) ?? perClub.set(c.clubId, { club, lines: [] }).get(c.clubId)!).lines.push(line);
  }
  let admins = 0;
  for (const [clubId, { club, lines }] of perClub) {
    const to = await adminRecipients(db, clubId);
    const res = await notifyUsers(db, deliver, to, {
      kind: "volunteer",
      subject: `Børneattester i ${club}: ${lines.length} kræver handling`,
      body: `${lines.join("\n")}\n\nSe listen under Forening, Børneattester.`,
      sms: `${club}: ${lines.length} børneattester kræver handling.`,
      url: `/forening/attester?klub=${clubId}`,
      dedupeKey: `cert-admin:${clubId}:${week}`,
    });
    admins += res.sent;
  }
  return { personal, admins };
}

/** Foreningens medlemmer og holdfolk, til valg af person i kontrakter og attester. Kun admin. */
export async function listClubPeople(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  const members = await db
    .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(clubMemberships)
    .innerJoin(profiles, eq(profiles.id, clubMemberships.profileId))
    .where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.status, "active")));
  const staff = await db
    .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
    .where(and(eq(teams.clubId, clubId), eq(teamMembers.role, "coach")));
  const seen = new Map<string, { id: string; name: string }>();
  for (const p of [...members, ...staff]) seen.set(p.id, { id: p.id, name: `${p.firstName} ${p.lastName}` });
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, "da"));
}
