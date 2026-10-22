// Hold, familie og forening: hvem er på hvilke hold, invitationslinks og børneprofiler.
import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubMemberships, clubs, guardianships, profiles, teamMembers, teams, users } from "../db/schema";
import { assertCan, can, canActAs, type AccessContext } from "../auth/permissions";
import { loadProfileFacts, loadTeamFacts, loadTeamMemberIds } from "../auth/context";

export const newInviteCode = () => randomBytes(6).toString("base64url");

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
  await db.transaction(async (tx) => {
    await tx.insert(clubMemberships).values({ clubId: team.clubId, profileId }).onConflictDoNothing();
    await tx.insert(teamMembers).values({ teamId: team.id, profileId, role: "player" }).onConflictDoNothing();
  });
  return team;
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

/** Foreningens voksne medlemmer med login, til at vælge trænere blandt. */
export async function listClubAdults(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  return db
    .select({ profileId: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(clubMemberships)
    .innerJoin(profiles, eq(profiles.id, clubMemberships.profileId))
    .where(and(eq(clubMemberships.clubId, clubId), isNotNull(profiles.userId)))
    .orderBy(asc(profiles.firstName));
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
