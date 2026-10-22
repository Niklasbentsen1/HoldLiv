// Henter de fakta rettighedsmotoren skal bruge, direkte fra databasen.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  clubMemberships,
  clubRoles,
  events,
  guardianships,
  profiles,
  teamMembers,
  teams,
} from "../db/schema";
import { isMinor, type AccessContext, type EventFacts, type ProfileFacts, type TeamFacts } from "./permissions";

export async function loadAccessContext(db: Db, userId: string, today = new Date()): Promise<AccessContext> {
  const [own] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId));
  if (!own) throw new Error("Login'et har ingen profil");

  const [admin, coach, children] = await Promise.all([
    db.select({ clubId: clubRoles.clubId }).from(clubRoles).where(and(eq(clubRoles.profileId, own.id), eq(clubRoles.role, "admin"))),
    db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.profileId, own.id), eq(teamMembers.role, "coach"))),
    db
      .select({ id: profiles.id, birthDate: profiles.birthDate })
      .from(guardianships)
      .innerJoin(profiles, eq(profiles.id, guardianships.childProfileId))
      .where(eq(guardianships.guardianProfileId, own.id)),
  ]);

  return {
    userId,
    profileId: own.id,
    adminClubs: new Set(admin.map((r) => r.clubId)),
    coachTeams: new Set(coach.map((r) => r.teamId)),
    wards: new Set(children.filter((c) => isMinor(c.birthDate, today)).map((c) => c.id)),
  };
}

export async function loadProfileFacts(db: Db, profileId: string): Promise<ProfileFacts> {
  const [clubs, teamRows] = await Promise.all([
    db.select({ clubId: clubMemberships.clubId }).from(clubMemberships).where(eq(clubMemberships.profileId, profileId)),
    db.selectDistinct({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.profileId, profileId)),
  ]);
  return { profileId, clubIds: clubs.map((c) => c.clubId), teamIds: teamRows.map((t) => t.teamId) };
}

export async function loadTeamFacts(db: Db, teamId: string): Promise<TeamFacts> {
  const [team] = await db.select({ teamId: teams.id, clubId: teams.clubId }).from(teams).where(eq(teams.id, teamId));
  if (!team) throw new Error("Holdet findes ikke");
  return team;
}

export async function loadTeamMemberIds(db: Db, teamId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ id: teamMembers.profileId }).from(teamMembers).where(eq(teamMembers.teamId, teamId));
  return rows.map((r) => r.id);
}

export async function loadEventFacts(db: Db, eventId: string): Promise<EventFacts> {
  const [event] = await db.select({ teamId: events.teamId, clubId: events.clubId }).from(events).where(eq(events.id, eventId));
  if (!event) throw new Error("Aktiviteten findes ikke");
  return event;
}

/** Profiler login'et kan skifte til i appen: sig selv og sine børn. */
export async function loadActingProfiles(db: Db, ctx: AccessContext) {
  const ids = [ctx.profileId, ...ctx.wards];
  const rows = await db
    .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(profiles)
    .where(inArray(profiles.id, ids));
  return rows
    .map((r) => ({ ...r, isSelf: r.id === ctx.profileId }))
    .sort((a, b) => Number(b.isSelf) - Number(a.isSelf) || a.firstName.localeCompare(b.firstName, "da"));
}
