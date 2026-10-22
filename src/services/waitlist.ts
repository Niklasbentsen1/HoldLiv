// Kapacitet og venteliste pr. hold. Er holdet fuldt, havner nye spillere på ventelisten; træneren (eller
// automatikken) rykker dem op, når der bliver plads. Ventelisten er rækkefølgen af created_at.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubMemberships, guardianships, profiles, teamMembers, teams, teamWaitlist } from "../db/schema";
import { loadTeamFacts } from "../auth/context";
import { assertCan, canActAs, type AccessContext } from "../auth/permissions";
import { notifyUsers, recipientsOfPlayers, type Deliver } from "./notifications";
import { removeTeamMember } from "./index";
import { applyTeamDefaultFee } from "./teams";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Pick<Db, "select">;

export interface GuardianContact {
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
}

export interface TeamSpots {
  capacity: number | null;
  autoPromote: boolean;
  players: number;
  /** Ledige pladser; null når holdet er ubegrænset. */
  free: number | null;
  full: boolean;
  waiting: number;
}

export async function teamSpots(db: Reader, teamId: string): Promise<TeamSpots> {
  const [t] = await db.select({ capacity: teams.capacity, autoPromote: teams.autoPromote }).from(teams).where(eq(teams.id, teamId));
  if (!t) throw new Error("Holdet findes ikke");
  const [{ players }] = await db
    .select({ players: sql<number>`count(*)::int` })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "player")));
  const [{ waiting }] = await db.select({ waiting: sql<number>`count(*)::int` }).from(teamWaitlist).where(eq(teamWaitlist.teamId, teamId));
  const free = t.capacity === null ? null : Math.max(0, t.capacity - players);
  return { capacity: t.capacity, autoPromote: t.autoPromote, players, free, full: free === 0, waiting };
}

/** Låser holdets række, så to samtidige tilmeldinger ikke begge tager den sidste plads, og giver pladserne. */
export async function lockTeamSpots(tx: Tx, teamId: string): Promise<TeamSpots> {
  await tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).for("update");
  return teamSpots(tx, teamId);
}

export async function setTeamCapacity(db: Db, ctx: AccessContext, teamId: string, capacity: number | null, autoPromote?: boolean, deliver?: Deliver) {
  assertCan(ctx, { action: "team.manage", team: await loadTeamFacts(db, teamId) });
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 0 || capacity > 500)) throw new Error("Antal pladser skal være et helt tal fra 0 til 500.");
  await db
    .update(teams)
    .set({ capacity, ...(autoPromote === undefined ? {} : { autoPromote }) })
    .where(eq(teams.id, teamId));
  await fillOpenSpots(db, ctx, teamId, deliver);
}

/** Sætter en person på holdets venteliste. Gør ingenting, hvis personen allerede er spiller eller venter. */
export async function joinWaitlist(db: Db, ctx: AccessContext, teamId: string, profileId: string, note?: string | null) {
  assertCan(ctx, { action: "profile.actAs", profileId });
  return addToWaitlist(db, ctx.userId, teamId, profileId, note);
}

export async function addToWaitlist(db: Pick<Db, "select" | "insert">, userId: string | null, teamId: string, profileId: string, note?: string | null) {
  const [already] = await db
    .select({ id: teamMembers.profileId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.profileId, profileId), eq(teamMembers.role, "player")));
  if (already) return { position: 0, added: false };
  await db
    .insert(teamWaitlist)
    .values({ teamId, profileId, requestedByUserId: userId, note: note?.trim() || null })
    .onConflictDoNothing();
  return { position: await positionOf(db, teamId, profileId), added: true };
}

async function positionOf(db: Reader, teamId: string, profileId: string) {
  const rows = await db.select({ profileId: teamWaitlist.profileId }).from(teamWaitlist).where(eq(teamWaitlist.teamId, teamId)).orderBy(asc(teamWaitlist.createdAt), asc(teamWaitlist.profileId));
  return rows.findIndex((r) => r.profileId === profileId) + 1;
}

/** Personen (eller værgen) trækker sig fra ventelisten, eller træneren fjerner vedkommende. */
export async function leaveWaitlist(db: Db, ctx: AccessContext, teamId: string, profileId: string) {
  const team = await loadTeamFacts(db, teamId);
  if (!canActAs(ctx, profileId)) assertCan(ctx, { action: "team.players.manage", team });
  await db.delete(teamWaitlist).where(and(eq(teamWaitlist.teamId, teamId), eq(teamWaitlist.profileId, profileId)));
}

/** Holdets venteliste i rækkefølge. Trænere og admin ser alle med forældre; andre ser kun deres egne. */
export async function listWaitlist(db: Db, ctx: AccessContext, teamId: string) {
  const team = await loadTeamFacts(db, teamId);
  const lead = (() => {
    try {
      assertCan(ctx, { action: "team.players.manage", team });
      return true;
    } catch {
      return false;
    }
  })();
  const rows = await db
    .select({ profileId: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, birthDate: profiles.birthDate, note: teamWaitlist.note, since: teamWaitlist.createdAt })
    .from(teamWaitlist)
    .innerJoin(profiles, eq(profiles.id, teamWaitlist.profileId))
    .where(eq(teamWaitlist.teamId, teamId))
    .orderBy(asc(teamWaitlist.createdAt), asc(profiles.id));
  const withPosition = rows.map((r, i) => ({ ...r, position: i + 1, mine: canActAs(ctx, r.profileId) }));
  // Andre ser kun deres egne, uden forældre og besked.
  if (!lead) return withPosition.filter((r) => r.mine).map(({ birthDate, note, ...r }) => ({ ...r, note: null as string | null, guardians: [] as GuardianContact[] }));
  const guardians = rows.length
    ? await db
        .select({ childId: guardianships.childProfileId, firstName: profiles.firstName, lastName: profiles.lastName, phone: profiles.phone, email: profiles.email })
        .from(guardianships)
        .innerJoin(profiles, eq(profiles.id, guardianships.guardianProfileId))
        .where(inArray(guardianships.childProfileId, rows.map((r) => r.profileId)))
    : [];
  return withPosition.map(({ birthDate, ...r }) => ({ ...r, guardians: guardians.filter((g) => g.childId === r.profileId).map(({ childId, ...g }): GuardianContact => g) }));
}

/** Ventelister for en selv og ens børn, til Familie-siden. */
export async function myWaitlistPositions(db: Db, ctx: AccessContext) {
  const ids = [ctx.profileId, ...ctx.wards];
  const rows = await db
    .select({ teamId: teams.id, team: teams.name, profileId: teamWaitlist.profileId })
    .from(teamWaitlist)
    .innerJoin(teams, eq(teams.id, teamWaitlist.teamId))
    .where(inArray(teamWaitlist.profileId, ids));
  const out = [];
  for (const r of rows) out.push({ ...r, position: await positionOf(db, r.teamId, r.profileId) });
  return out;
}

async function promoteOne(tx: Tx, teamId: string, profileId: string) {
  const [team] = await tx.select({ clubId: teams.clubId }).from(teams).where(eq(teams.id, teamId));
  await tx.insert(clubMemberships).values({ clubId: team.clubId, profileId }).onConflictDoNothing();
  await tx.insert(teamMembers).values({ teamId, profileId, role: "player" }).onConflictDoNothing();
  await applyTeamDefaultFee(tx, teamId, profileId);
  await tx.delete(teamWaitlist).where(and(eq(teamWaitlist.teamId, teamId), eq(teamWaitlist.profileId, profileId)));
}

async function tellPromoted(db: Db, deliver: Deliver | undefined, teamId: string, profileIds: string[]) {
  if (!deliver || profileIds.length === 0) return;
  const [t] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId));
  for (const profileId of profileIds) {
    const [p] = await db.select({ firstName: profiles.firstName }).from(profiles).where(eq(profiles.id, profileId));
    const recipients = await recipientsOfPlayers(db, [profileId]);
    await notifyUsers(db, deliver, recipients, {
      kind: "waitlist",
      subject: `Plads på ${t.name}`,
      body: `${p.firstName} har fået en plads på ${t.name} og er nu med på holdet.\n\nSe holdet: ${deliver.baseUrl}/hold/${teamId}`,
      sms: `${p.firstName} har fået plads på ${t.name}`,
      url: `/hold/${teamId}`,
      dedupeKey: `team-promote:${teamId}:${profileId}:${Date.now()}`,
    });
  }
}

/** Træneren rykker en bestemt person op fra ventelisten. Kræver en ledig plads, medmindre man bevidst overtrækker. */
export async function promoteFromWaitlist(db: Db, ctx: AccessContext, teamId: string, profileId: string, opts: { allowOverfull?: boolean; deliver?: Deliver } = {}) {
  assertCan(ctx, { action: "team.players.manage", team: await loadTeamFacts(db, teamId) });
  await db.transaction(async (tx) => {
    const [w] = await tx.select({ id: teamWaitlist.profileId }).from(teamWaitlist).where(and(eq(teamWaitlist.teamId, teamId), eq(teamWaitlist.profileId, profileId)));
    if (!w) throw new Error("Personen står ikke på ventelisten.");
    const spots = await lockTeamSpots(tx, teamId);
    if (spots.full && !opts.allowOverfull) throw new Error("Holdet er fuldt. Hæv antallet af pladser først.");
    await promoteOne(tx, teamId, profileId);
  });
  await tellPromoted(db, opts.deliver, teamId, [profileId]);
}

/** Rykker de første på ventelisten op, så længe der er ledige pladser og holdet har slået automatik til. */
export async function fillOpenSpots(db: Db, ctx: AccessContext | null, teamId: string, deliver?: Deliver): Promise<string[]> {
  const moved = await db.transaction(async (tx) => {
    const spots = await lockTeamSpots(tx, teamId);
    if (!spots.autoPromote || spots.free === 0) return [] as string[];
    const next = await tx
      .select({ profileId: teamWaitlist.profileId })
      .from(teamWaitlist)
      .where(eq(teamWaitlist.teamId, teamId))
      .orderBy(asc(teamWaitlist.createdAt), asc(teamWaitlist.profileId))
      .limit(spots.free ?? 1000);
    for (const n of next) await promoteOne(tx, teamId, n.profileId);
    return next.map((n) => n.profileId);
  });
  await tellPromoted(db, deliver, teamId, moved);
  return moved;
}

/** Giv trænerne besked, når der er blevet en plads og nogen venter. */
export async function tellCoachesSpotFree(db: Db, deliver: Deliver, teamId: string) {
  const spots = await teamSpots(db, teamId);
  if (spots.waiting === 0 || spots.free === 0 || spots.autoPromote) return;
  const coaches = await db.select({ profileId: teamMembers.profileId }).from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "coach")));
  const [t] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId));
  await notifyUsers(db, deliver, await recipientsOfPlayers(db, coaches.map((c) => c.profileId)), {
    kind: "waitlist",
    subject: `Ledig plads på ${t.name}`,
    body: `Der er en ledig plads på ${t.name}, og ${spots.waiting} står på ventelisten.\n\nRyk den første op: ${deliver.baseUrl}/hold/${teamId}`,
    sms: `Ledig plads på ${t.name}, ${spots.waiting} venter`,
    url: `/hold/${teamId}`,
    dedupeKey: `team-spot:${teamId}:${spots.players}`,
  });
}

/** Fjerner en spiller; derefter rykker automatikken op, eller trænerne får besked om den ledige plads. */
export async function removePlayerNotifying(db: Db, ctx: AccessContext, deliver: Deliver, teamId: string, profileId: string) {
  await removeTeamMember(db, ctx, teamId, profileId, "player");
  const moved = await fillOpenSpots(db, ctx, teamId, deliver);
  if (moved.length === 0) await tellCoachesSpotFree(db, deliver, teamId);
}
