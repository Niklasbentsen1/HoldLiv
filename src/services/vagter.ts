// Vagtplan for frivillige: kioskvagt, opstilling, stævnevagt og lignende.
//
// Regler:
//   - Foreningens admin opretter vagter. Et holds træner kan oprette vagter for sit eget hold. Antal pladser bestemmer den, der opretter vagten.
//   - Medlemmer af foreningen tager en vagt for sig selv; en forælder kan tage den for et barn fra 15 år. Pladserne er først til mølle.
//   - Kræver vagten børneattest (fx vagt med børn), kan man kun tage den med en gyldig attest på vagtens dag (se attester.ts).
//   - Man kan ikke tage to vagter, der overlapper. Afmelding er åben til vagten begynder; admin og holdets træner kan altid fjerne en frivillig.
//   - Aflyses en vagt, får de tilmeldte besked. Dagen før en vagt får de tilmeldte en påmindelse.
import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubMemberships, profiles, shiftSignups, teams, volunteerShifts } from "../db/schema";
import { assertCan, canActAs, type AccessContext } from "../auth/permissions";
import { ageOn } from "../lib/age";
import { localDate } from "../lib/money";
import { when } from "../lib/format";
import { logAudit } from "./audit";
import { hasValidCertificate } from "./attester";
import { notifyUsers, recipientsOfPlayers, type Deliver } from "./notifications";

/** Yngste alder for en frivillig. */
export const MIN_VOLUNTEER_AGE = 15;
const MAX_SLOTS = 200;
const MAX_HOURS = 16;
const MAX_DAYS_AHEAD = 365;

export interface ShiftInput {
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: Date;
  endsAt: Date;
  slots?: number;
  teamId?: string | null;
  requiresChildCertificate?: boolean;
}

function clean(input: ShiftInput) {
  const title = input.title.trim();
  if (!title) throw new Error("Giv vagten en titel.");
  if (title.length > 120) throw new Error("Titlen må højst være på 120 tegn.");
  if (Number.isNaN(input.startsAt.getTime()) || Number.isNaN(input.endsAt.getTime())) throw new Error("Vælg start og slut.");
  const ms = input.endsAt.getTime() - input.startsAt.getTime();
  if (ms < 15 * 60000) throw new Error("Vagten skal vare mindst 15 minutter.");
  if (ms > MAX_HOURS * 3600000) throw new Error(`Vagten må højst vare ${MAX_HOURS} timer.`);
  const slots = input.slots ?? 1;
  if (!Number.isInteger(slots) || slots < 1 || slots > MAX_SLOTS) throw new Error(`Antal pladser skal være et helt tal fra 1 til ${MAX_SLOTS}.`);
  return {
    title,
    description: input.description?.trim() || null,
    location: input.location?.trim() || null,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    slots,
    requiresChildCertificate: !!input.requiresChildCertificate,
  };
}

async function loadShift(db: Pick<Db, "select">, id: string) {
  const [s] = await db.select().from(volunteerShifts).where(eq(volunteerShifts.id, id));
  if (!s) throw new Error("Vagten findes ikke.");
  return s;
}

/** Må login'et oprette, rette og aflyse vagten? Admin altid; en træner for sit eget hold. */
function canManageShift(ctx: AccessContext, s: { clubId: string; teamId: string | null }) {
  return ctx.adminClubs.has(s.clubId) || (s.teamId !== null && ctx.coachTeams.has(s.teamId));
}

function assertManage(ctx: AccessContext, s: { clubId: string; teamId: string | null }) {
  if (s.teamId) assertCan(ctx, { action: "team.manage", team: { teamId: s.teamId, clubId: s.clubId } });
  else assertCan(ctx, { action: "club.manage", clubId: s.clubId });
}

export async function createShift(db: Db, ctx: AccessContext, clubId: string, input: ShiftInput) {
  const values = clean(input);
  const teamId = input.teamId || null;
  if (teamId) {
    const [t] = await db.select({ clubId: teams.clubId }).from(teams).where(eq(teams.id, teamId));
    if (!t || t.clubId !== clubId) throw new Error("Holdet hører ikke til foreningen.");
  }
  assertManage(ctx, { clubId, teamId });
  if (values.startsAt.getTime() < ctx.now.getTime()) throw new Error("Starttidspunktet ligger i fortiden.");
  if (values.startsAt.getTime() > ctx.now.getTime() + MAX_DAYS_AHEAD * 86400000) throw new Error("Man kan højst oprette vagter et år frem.");
  const [s] = await db.insert(volunteerShifts).values({ clubId, teamId, createdByUserId: ctx.userId, ...values }).returning();
  await logAudit(db, { action: "shift.created", clubId, actorUserId: ctx.userId, targetType: "volunteer_shift", targetId: s.id });
  return s;
}

export async function updateShift(db: Db, ctx: AccessContext, shiftId: string, input: ShiftInput) {
  const s = await loadShift(db, shiftId);
  assertManage(ctx, s);
  if (s.cancelledAt) throw new Error("Vagten er aflyst.");
  const values = clean(input);
  await db.transaction(async (tx) => {
    await tx.select({ id: volunteerShifts.id }).from(volunteerShifts).where(eq(volunteerShifts.id, shiftId)).for("update");
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(shiftSignups)
      .where(and(eq(shiftSignups.shiftId, shiftId), isNull(shiftSignups.cancelledAt)));
    if (values.slots < n) throw new Error(`Der er allerede ${n} tilmeldt. Fjern nogen først, eller behold mindst ${n} pladser.`);
    await tx.update(volunteerShifts).set(values).where(eq(volunteerShifts.id, shiftId));
  });
  await logAudit(db, { action: "shift.updated", clubId: s.clubId, actorUserId: ctx.userId, targetType: "volunteer_shift", targetId: shiftId });
}

/** Aflyser vagten; de tilmeldte får besked. */
export async function cancelShift(db: Db, ctx: AccessContext, shiftId: string, deliver?: Deliver) {
  const s = await loadShift(db, shiftId);
  assertManage(ctx, s);
  const done = await db.update(volunteerShifts).set({ cancelledAt: ctx.now }).where(and(eq(volunteerShifts.id, shiftId), isNull(volunteerShifts.cancelledAt))).returning({ id: volunteerShifts.id });
  if (done.length === 0) throw new Error("Vagten er allerede aflyst.");
  await logAudit(db, { action: "shift.cancelled", clubId: s.clubId, actorUserId: ctx.userId, targetType: "volunteer_shift", targetId: shiftId });
  if (!deliver) return;
  const people = await db.select({ profileId: shiftSignups.profileId }).from(shiftSignups).where(and(eq(shiftSignups.shiftId, shiftId), isNull(shiftSignups.cancelledAt)));
  await notifyUsers(db, deliver, await recipientsOfPlayers(db, people.map((p) => p.profileId), ctx.now), {
    kind: "volunteer",
    subject: `Vagten "${s.title}" er aflyst`,
    body: `Vagten "${s.title}" ${when(s.startsAt, s.endsAt)} er aflyst.`,
    sms: `Vagten "${s.title}" er aflyst.`,
    url: "/vagtplan",
    dedupeKey: `shift:${shiftId}:cancelled`,
  });
}

export async function signUpForShift(db: Db, ctx: AccessContext, shiftId: string, profileId?: string) {
  const target = profileId ?? ctx.profileId;
  if (!canActAs(ctx, target)) assertCan(ctx, { action: "profile.actAs", profileId: target });
  const s0 = await loadShift(db, shiftId);
  if (s0.cancelledAt) throw new Error("Vagten er aflyst.");
  if (s0.startsAt.getTime() <= ctx.now.getTime()) throw new Error("Vagten er begyndt.");
  const [member] = await db
    .select({ birthDate: profiles.birthDate })
    .from(clubMemberships)
    .innerJoin(profiles, eq(profiles.id, clubMemberships.profileId))
    .where(and(eq(clubMemberships.clubId, s0.clubId), eq(clubMemberships.profileId, target), eq(clubMemberships.status, "active")));
  if (!member) throw new Error("Kun aktive medlemmer af foreningen kan tage vagter.");
  if (member.birthDate && ageOn(member.birthDate, localDate(s0.startsAt)) < MIN_VOLUNTEER_AGE) throw new Error(`Frivillige skal være mindst ${MIN_VOLUNTEER_AGE} år på vagtens dag.`);
  if (s0.requiresChildCertificate && !(await hasValidCertificate(db, s0.clubId, target, s0.startsAt))) {
    throw new Error("Vagten kræver en gyldig børneattest. Kontakt foreningen, så de kan få den på plads.");
  }
  await db.transaction(async (tx) => {
    // Lås vagten, så to samtidige tilmeldinger ikke begge tager den sidste plads.
    const [s] = await tx.select().from(volunteerShifts).where(eq(volunteerShifts.id, shiftId)).for("update");
    if (s.cancelledAt) throw new Error("Vagten er aflyst.");
    const active = await tx.select({ profileId: shiftSignups.profileId }).from(shiftSignups).where(and(eq(shiftSignups.shiftId, shiftId), isNull(shiftSignups.cancelledAt)));
    if (active.some((a) => a.profileId === target)) throw new Error("Der er allerede tilmeldt til vagten.");
    if (active.length >= s.slots) throw new Error("Vagten er fuld.");
    const [clash] = await tx
      .select({ title: volunteerShifts.title })
      .from(shiftSignups)
      .innerJoin(volunteerShifts, eq(volunteerShifts.id, shiftSignups.shiftId))
      .where(and(eq(shiftSignups.profileId, target), isNull(shiftSignups.cancelledAt), isNull(volunteerShifts.cancelledAt), lt(volunteerShifts.startsAt, s.endsAt), gt(volunteerShifts.endsAt, s.startsAt)));
    if (clash) throw new Error(`Der er en anden vagt i samme tidsrum: ${clash.title}.`);
    await tx
      .insert(shiftSignups)
      .values({ shiftId, clubId: s.clubId, profileId: target, signedUpByUserId: ctx.userId })
      .onConflictDoUpdate({ target: [shiftSignups.shiftId, shiftSignups.profileId], set: { cancelledAt: null, reminderSentAt: null, signedUpByUserId: ctx.userId, createdAt: ctx.now } });
  });
  await logAudit(db, { action: "shift.signed_up", clubId: s0.clubId, actorUserId: ctx.userId, targetType: "volunteer_shift", targetId: shiftId, detail: { profileId: target } });
}

/** Afmelder. Den tilmeldte (eller en værge) kan det, til vagten begynder; admin og holdets træner kan altid. */
export async function cancelShiftSignup(db: Db, ctx: AccessContext, shiftId: string, profileId: string) {
  const s = await loadShift(db, shiftId);
  const manager = canManageShift(ctx, s);
  if (!manager) {
    if (!canActAs(ctx, profileId)) assertCan(ctx, { action: "profile.actAs", profileId });
    if (s.startsAt.getTime() <= ctx.now.getTime()) throw new Error("Vagten er begyndt og kan ikke afmeldes. Kontakt foreningen.");
  }
  const done = await db
    .update(shiftSignups)
    .set({ cancelledAt: ctx.now })
    .where(and(eq(shiftSignups.shiftId, shiftId), eq(shiftSignups.profileId, profileId), isNull(shiftSignups.cancelledAt)))
    .returning({ id: shiftSignups.id });
  if (done.length === 0) throw new Error("Der er ingen tilmelding at fjerne.");
  await logAudit(db, { action: "shift.signup_cancelled", clubId: s.clubId, actorUserId: ctx.userId, targetType: "volunteer_shift", targetId: shiftId, detail: { profileId } });
}

/**
 * Kommende vagter i de foreninger, man (eller ens børn) er medlem af. Alle ser pladser og fornavne; admin og holdets træner ser fulde navne
 * og kan administrere. `mine` er de af ens egne personer, der er tilmeldt; `blocked` siger, hvem der ikke kan tage vagten endnu (manglende attest).
 */
export async function listShifts(db: Db, ctx: AccessContext) {
  const people = [ctx.profileId, ...ctx.wards];
  const memberships = await db
    .select({ clubId: clubMemberships.clubId, profileId: clubMemberships.profileId })
    .from(clubMemberships)
    .where(and(inArray(clubMemberships.profileId, people), eq(clubMemberships.status, "active")));
  const clubIds = [...new Set([...memberships.map((m) => m.clubId), ...ctx.adminClubs])];
  if (clubIds.length === 0) return [];
  const shifts = await db
    .select({ s: volunteerShifts, teamName: teams.name })
    .from(volunteerShifts)
    .leftJoin(teams, eq(teams.id, volunteerShifts.teamId))
    .where(and(inArray(volunteerShifts.clubId, clubIds), gt(volunteerShifts.endsAt, ctx.now), isNull(volunteerShifts.cancelledAt)))
    .orderBy(asc(volunteerShifts.startsAt));
  if (shifts.length === 0) return [];
  const signups = await db
    .select({ shiftId: shiftSignups.shiftId, profileId: shiftSignups.profileId, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(shiftSignups)
    .innerJoin(profiles, eq(profiles.id, shiftSignups.profileId))
    .where(and(inArray(shiftSignups.shiftId, shifts.map((x) => x.s.id)), isNull(shiftSignups.cancelledAt)))
    .orderBy(asc(shiftSignups.createdAt));
  const nameRows = await db.select({ id: profiles.id, firstName: profiles.firstName, birthDate: profiles.birthDate }).from(profiles).where(inArray(profiles.id, people));
  return Promise.all(
    shifts.map(async ({ s, teamName }) => {
      const manage = canManageShift(ctx, s);
      const signed = signups.filter((x) => x.shiftId === s.id);
      const candidates = memberships.filter((m) => m.clubId === s.clubId);
      const options = await Promise.all(
        candidates.map(async (m) => {
          const p = nameRows.find((n) => n.id === m.profileId);
          const tooYoung = !!p?.birthDate && ageOn(p.birthDate, localDate(s.startsAt)) < MIN_VOLUNTEER_AGE;
          const missingCertificate = s.requiresChildCertificate && !(await hasValidCertificate(db, s.clubId, m.profileId, s.startsAt));
          return { profileId: m.profileId, firstName: p?.firstName ?? "", self: m.profileId === ctx.profileId, signedUp: signed.some((x) => x.profileId === m.profileId), tooYoung, missingCertificate };
        }),
      );
      return {
        ...s,
        teamName,
        manage,
        filled: signed.length,
        volunteers: signed.map((x) => ({ profileId: x.profileId, name: manage ? `${x.firstName} ${x.lastName}` : x.firstName, mine: canActAs(ctx, x.profileId) })),
        options,
      };
    }),
  );
}

/** Hold, man kan oprette vagter for: alle i foreningen for admin, ellers de hold, man træner. */
export async function listShiftTeams(db: Db, ctx: AccessContext) {
  const rows = await db.select({ id: teams.id, name: teams.name, clubId: teams.clubId }).from(teams);
  return rows.filter((t) => ctx.adminClubs.has(t.clubId) || ctx.coachTeams.has(t.id));
}

/** Påmindelse til de tilmeldte, når vagten begynder inden for et døgn. Hver tilmelding får højst én påmindelse. */
export async function sendShiftReminders(db: Db, deliver: Deliver, now = new Date()) {
  const horizon = new Date(now.getTime() + 24 * 3600000);
  const rows = await db
    .select({ signupId: shiftSignups.id, profileId: shiftSignups.profileId, title: volunteerShifts.title, location: volunteerShifts.location, startsAt: volunteerShifts.startsAt, endsAt: volunteerShifts.endsAt })
    .from(shiftSignups)
    .innerJoin(volunteerShifts, eq(volunteerShifts.id, shiftSignups.shiftId))
    .where(and(isNull(shiftSignups.cancelledAt), isNull(shiftSignups.reminderSentAt), isNull(volunteerShifts.cancelledAt), gt(volunteerShifts.startsAt, now), lt(volunteerShifts.startsAt, horizon)));
  let sent = 0;
  for (const r of rows) {
    const claimed = await db.update(shiftSignups).set({ reminderSentAt: now }).where(and(eq(shiftSignups.id, r.signupId), isNull(shiftSignups.reminderSentAt))).returning({ id: shiftSignups.id });
    if (claimed.length === 0) continue;
    const res = await notifyUsers(db, deliver, await recipientsOfPlayers(db, [r.profileId], now), {
      kind: "volunteer",
      subject: `Påmindelse: vagt "${r.title}"`,
      body: `Du har vagten "${r.title}" ${when(r.startsAt, r.endsAt)}${r.location ? ` ved ${r.location}` : ""}.`,
      sms: `Påmindelse: vagt "${r.title}" ${when(r.startsAt)}.`,
      url: "/vagtplan",
      dedupeKey: `shift-reminder:${r.signupId}`,
    });
    sent += res.sent;
  }
  return { sent };
}
