// Hold, familie og forening: hvem er på hvilke hold, invitationslinks og børneprofiler.
import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubMemberships, clubs, guardianships, profiles, teamMembers, teams, teamWaitlist, users } from "../db/schema";
import { assertCan, can, canActAs, type AccessContext } from "../auth/permissions";
import { loadProfileFacts, loadTeamFacts, loadTeamMemberIds } from "../auth/context";
import { addToWaitlist, lockTeamSpots, teamSpots } from "./waitlist";

export const newInviteCode = () => randomBytes(6).toString("base64url");

/** Ny spiller uden kontingent får holdets standardkontingent. Et kontingent sat af kassereren røres ikke. */
export async function applyTeamDefaultFee(db: Pick<Db, "update">, teamId: string, profileId: string) {
  await db
    .update(clubMemberships)
    .set({ feeId: sql`(select ${teams.defaultFeeId} from ${teams} where ${teams.id} = ${teamId})` })
    .where(
      and(
        eq(clubMemberships.profileId, profileId),
        isNull(clubMemberships.feeId),
        eq(clubMemberships.clubId, sql`(select ${teams.clubId} from ${teams} where ${teams.id} = ${teamId})`),
      ),
    );
}

const ROLE_LABEL = { coach: "Træner", player: "Spiller" } as const;

/** Holdene login'et har med at gøre: egne hold, børnenes hold og alle hold i foreninger man er admin for. */
export async function listMyTeams(db: Db, ctx: AccessContext) {
  const actingIds = [ctx.profileId, ...ctx.wards];
  const memberRows = await db
    .select({
      teamId: teams.id,
      name: teams.name,
      season: teams.season,
      clubId: teams.clubId,
      clubName: clubs.name,
      profileId: profiles.id,
      firstName: profiles.firstName,
      role: teamMembers.role,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .innerJoin(clubs, eq(clubs.id, teams.clubId))
    .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
    .where(inArray(teamMembers.profileId, actingIds));
  const adminRows = ctx.adminClubs.size
    ? await db
        .select({ teamId: teams.id, name: teams.name, season: teams.season, clubId: teams.clubId, clubName: clubs.name })
        .from(teams)
        .innerJoin(clubs, eq(clubs.id, teams.clubId))
        .where(inArray(teams.clubId, [...ctx.adminClubs]))
    : [];

  const byTeam = new Map<string, { id: string; name: string; season: string | null; clubName: string; labels: string[] }>();
  const entry = (r: { teamId: string; name: string; season: string | null; clubName: string }) => {
    let t = byTeam.get(r.teamId);
    if (!t) byTeam.set(r.teamId, (t = { id: r.teamId, name: r.name, season: r.season, clubName: r.clubName, labels: [] }));
    return t;
  };
  for (const r of memberRows) {
    const self = r.profileId === ctx.profileId;
    entry(r).labels.push(self ? ROLE_LABEL[r.role] : `${r.firstName} er ${ROLE_LABEL[r.role].toLowerCase()}`);
  }
  for (const r of adminRows) {
    const t = entry(r);
    if (t.labels.length === 0) t.labels.push("Admin");
  }
  return [...byTeam.values()].sort((a, b) => a.name.localeCompare(b.name, "da"));
}

/** Holdets side: trænere, spillere og (for trænere/admins) forældre og invitationslink. */
export async function getTeam(db: Db, ctx: AccessContext, teamId: string) {
  const facts = await loadTeamFacts(db, teamId);
  assertCan(ctx, { action: "team.view", team: facts, memberProfileIds: await loadTeamMemberIds(db, teamId) });
  const leads = can(ctx, { action: "team.manage", team: facts });

  const [[team], members] = await Promise.all([
    db
      .select({ id: teams.id, name: teams.name, season: teams.season, inviteCode: teams.inviteCode, clubName: clubs.name, clubId: clubs.id })
      .from(teams)
      .innerJoin(clubs, eq(clubs.id, teams.clubId))
      .where(eq(teams.id, teamId)),
    db
      .select({
        profileId: profiles.id,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        hasLogin: profiles.userId,
        role: teamMembers.role,
      })
      .from(teamMembers)
      .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(asc(profiles.firstName)),
  ]);

  const players = members.filter((m) => m.role === "player");
  // Forældrenes navne vises kun for trænere og admins, så de ved hvem de skal kontakte.
  const guardianRows =
    leads && players.length
      ? await db
          .select({ childId: guardianships.childProfileId, firstName: profiles.firstName, lastName: profiles.lastName, phone: profiles.phone, email: profiles.email })
          .from(guardianships)
          .innerJoin(profiles, eq(profiles.id, guardianships.guardianProfileId))
          .where(inArray(guardianships.childProfileId, players.map((p) => p.profileId)))
      : [];

  return {
    id: team.id,
    name: team.name,
    season: team.season,
    clubId: team.clubId,
    clubName: team.clubName,
    inviteCode: leads ? team.inviteCode : null,
    canManage: leads,
    spots: await teamSpots(db, teamId),
    canManageCoaches: can(ctx, { action: "team.coaches.manage", team: facts }),
    coaches: members.filter((m) => m.role === "coach").map(({ profileId, firstName, lastName }) => ({ profileId, firstName, lastName })),
    players: players.map((p) => ({
      profileId: p.profileId,
      firstName: p.firstName,
      lastName: p.lastName,
      mine: canActAs(ctx, p.profileId),
      guardians: guardianRows.filter((g) => g.childId === p.profileId).map(({ childId, ...g }) => g),
    })),
  };
}

export async function rotateInviteCode(db: Db, ctx: AccessContext, teamId: string) {
  assertCan(ctx, { action: "team.manage", team: await loadTeamFacts(db, teamId) });
  const [t] = await db.update(teams).set({ inviteCode: newInviteCode() }).where(eq(teams.id, teamId)).returning();
  return t.inviteCode;
}

export async function findTeamByInvite(db: Db, code: string) {
  const [t] = await db
    .select({ id: teams.id, name: teams.name, season: teams.season, clubId: teams.clubId, clubName: clubs.name })
    .from(teams)
    .innerJoin(clubs, eq(clubs.id, teams.clubId))
    .where(eq(teams.inviteCode, code));
  return t ?? null;
}

/**
 * Tilmeld sig selv eller sit barn som spiller via holdets invitationslink.
 * Linket er selve tilladelsen; træneren kan fjerne spillere igen og nulstille linket.
 */
export async function joinTeamByInvite(db: Db, ctx: AccessContext, code: string, profileId: string) {
  assertCan(ctx, { action: "profile.actAs", profileId });
  const team = await findTeamByInvite(db, code);
  if (!team) throw new Error("Invitationslinket er ikke gyldigt længere. Bed træneren om et nyt.");
  const waitlisted = await db.transaction(async (tx) => {
    const spots = await lockTeamSpots(tx, team.id);
    const [already] = await tx
      .select({ id: teamMembers.profileId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.profileId, profileId), eq(teamMembers.role, "player")));
    // Er holdet fuldt, kommer man på ventelisten i stedet for på holdet.
    if (!already && spots.full) {
      await addToWaitlist(tx, ctx.userId, team.id, profileId);
      return true;
    }
    await tx.insert(clubMemberships).values({ clubId: team.clubId, profileId }).onConflictDoNothing();
    await tx.insert(teamMembers).values({ teamId: team.id, profileId, role: "player" }).onConflictDoNothing();
    await tx.delete(teamWaitlist).where(and(eq(teamWaitlist.teamId, team.id), eq(teamWaitlist.profileId, profileId)));
    await applyTeamDefaultFee(tx, team.id, profileId);
    return false;
  });
  return { ...team, waitlisted };
}

/** Børnene login'et er værge for, med hold og de andre værger. */
export async function listFamily(db: Db, ctx: AccessContext) {
  const ids = [...ctx.wards];
  if (ids.length === 0) return [];
  const [kids, teamRows, guardianRows] = await Promise.all([
    db.select().from(profiles).where(inArray(profiles.id, ids)).orderBy(asc(profiles.birthDate)),
    db
      .select({ profileId: teamMembers.profileId, teamId: teams.id, name: teams.name })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(inArray(teamMembers.profileId, ids), eq(teamMembers.role, "player"))),
    db
      .select({ childId: guardianships.childProfileId, profileId: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
      .from(guardianships)
      .innerJoin(profiles, eq(profiles.id, guardianships.guardianProfileId))
      .where(inArray(guardianships.childProfileId, ids)),
  ]);
  return kids.map((k) => ({
    id: k.id,
    firstName: k.firstName,
    lastName: k.lastName,
    birthDate: k.birthDate,
    teams: teamRows.filter((t) => t.profileId === k.id).map(({ teamId, name }) => ({ id: teamId, name })),
    otherGuardians: guardianRows
      .filter((g) => g.childId === k.id && g.profileId !== ctx.profileId)
      .map((g) => `${g.firstName} ${g.lastName}`),
  }));
}

/** Tilføj den anden forælder via e-mail. Personen skal have logget ind i HoldLiv én gang. */
export async function addGuardianByEmail(db: Db, ctx: AccessContext, childProfileId: string, email: string) {
  assertCan(ctx, { action: "profile.guardians.manage", profile: await loadProfileFacts(db, childProfileId) });
  const [row] = await db
    .select({ profileId: profiles.id })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(eq(users.email, email.trim().toLowerCase()));
  if (!row) throw new Error("Der er ingen i HoldLiv med den e-mail endnu. Bed personen logge ind én gang først.");
  await db.insert(guardianships).values({ guardianProfileId: row.profileId, childProfileId }).onConflictDoNothing();
}

/** Foreninger login'et er admin for, med hold og trænere. */
export async function listAdminClubs(db: Db, ctx: AccessContext) {
  const ids = [...ctx.adminClubs];
  if (ids.length === 0) return [];
  const [clubRows, teamRows, coachRows] = await Promise.all([
    db.select().from(clubs).where(inArray(clubs.id, ids)).orderBy(asc(clubs.name)),
    db.select().from(teams).where(inArray(teams.clubId, ids)).orderBy(asc(teams.name)),
    db
      .select({ teamId: teamMembers.teamId, firstName: profiles.firstName, lastName: profiles.lastName })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
      .where(and(inArray(teams.clubId, ids), eq(teamMembers.role, "coach"))),
  ]);
  return clubRows.map((c) => ({
    id: c.id,
    name: c.name,
    teams: teamRows
      .filter((t) => t.clubId === c.id)
      .map((t) => ({
        id: t.id,
        name: t.name,
        season: t.season,
        coaches: coachRows.filter((r) => r.teamId === t.id).map((r) => `${r.firstName} ${r.lastName}`),
      })),
  }));
}

/** Admin gør en person til træner via e-mail. Personen skal have logget ind i HoldLiv én gang. */
export async function addCoachByEmail(db: Db, ctx: AccessContext, teamId: string, email: string) {
  const team = await loadTeamFacts(db, teamId);
  assertCan(ctx, { action: "team.coaches.manage", team });
  const [row] = await db
    .select({ profileId: profiles.id })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(eq(users.email, email.trim().toLowerCase()));
  if (!row) throw new Error("Der er ingen i HoldLiv med den e-mail endnu. Bed personen logge ind én gang først.");
  await db.transaction(async (tx) => {
    await tx.insert(clubMemberships).values({ clubId: team.clubId, profileId: row.profileId }).onConflictDoNothing();
    await tx.insert(teamMembers).values({ teamId, profileId: row.profileId, role: "coach" }).onConflictDoNothing();
  });
}
