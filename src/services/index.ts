// Handlinger i HoldLiv. Hver funktion tjekker rettigheder via can()/assertCan()
// før den rører databasen, så web, app og AI-værktøjer deler samme regler.
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  clubMemberships,
  clubRoles,
  clubs,
  eventResponses,
  events,
  guardianships,
  profiles,
  teamMembers,
  teams,
  users,
} from "../db/schema";
import { assertCan, isMinor, type AccessContext } from "../auth/permissions";
import { loadEventFacts, loadProfileFacts, loadTeamFacts } from "../auth/context";
import { applyTeamDefaultFee, newInviteCode } from "./teams";

export interface PersonInput {
  firstName: string;
  lastName: string;
  birthDate?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** Opretter et login med tilhørende profil. */
export async function registerUser(db: Db, email: string, person: PersonInput) {
  return db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({ email: email.toLowerCase() }).returning();
    const [profile] = await tx
      .insert(profiles)
      .values({ ...person, email: person.email ?? user.email, userId: user.id, createdByUserId: user.id })
      .returning();
    return { user, profile };
  });
}

/** Første login: et login uden profil får sin egen profil. */
export async function createProfileForUser(db: Db, userId: string, person: PersonInput) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new Error("Login'et findes ikke");
  const [profile] = await db
    .insert(profiles)
    .values({ ...person, email: person.email ?? user.email, userId, createdByUserId: userId })
    .returning();
  return profile;
}

/** Forælderen opretter sit barns profil og bliver automatisk værge. */
export async function createChildProfile(db: Db, ctx: AccessContext, child: PersonInput & { birthDate: string }) {
  if (!isMinor(child.birthDate)) throw new Error("Børneprofiler er for personer under 18 år");
  return db.transaction(async (tx) => {
    const [profile] = await tx.insert(profiles).values({ ...child, createdByUserId: ctx.userId }).returning();
    await tx.insert(guardianships).values({ guardianProfileId: ctx.profileId, childProfileId: profile.id });
    return profile;
  });
}

/** Tilføj en ekstra værge, fx den anden forælder. */
export async function addGuardian(db: Db, ctx: AccessContext, childProfileId: string, guardianProfileId: string) {
  assertCan(ctx, { action: "profile.guardians.manage", profile: await loadProfileFacts(db, childProfileId) });
  await db.insert(guardianships).values({ guardianProfileId, childProfileId }).onConflictDoNothing();
}

export async function updateProfile(db: Db, ctx: AccessContext, profileId: string, patch: Partial<PersonInput>) {
  assertCan(ctx, { action: "profile.edit", profile: await loadProfileFacts(db, profileId) });
  const [p] = await db.update(profiles).set(patch).where(eq(profiles.id, profileId)).returning();
  return p;
}

/** Den der opretter foreningen, bliver dens første admin. */
export async function createClub(db: Db, ctx: AccessContext, name: string, slug: string) {
  return db.transaction(async (tx) => {
    const [club] = await tx.insert(clubs).values({ name, slug }).returning();
    await tx.insert(clubMemberships).values({ clubId: club.id, profileId: ctx.profileId });
    await tx.insert(clubRoles).values({ clubId: club.id, profileId: ctx.profileId, role: "admin", title: "Opretter" });
    return club;
  });
}

export async function addClubMember(db: Db, ctx: AccessContext, clubId: string, profileId: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  await db.insert(clubMemberships).values({ clubId, profileId }).onConflictDoNothing();
}

export async function grantClubAdmin(db: Db, ctx: AccessContext, clubId: string, profileId: string, title?: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  await db.insert(clubMemberships).values({ clubId, profileId }).onConflictDoNothing();
  await db.insert(clubRoles).values({ clubId, profileId, role: "admin", title }).onConflictDoNothing();
}

export async function revokeClubAdmin(db: Db, ctx: AccessContext, clubId: string, profileId: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  await db.transaction(async (tx) => {
    // Lås foreningens admin-rækker, så to samtidige fjernelser ikke efterlader foreningen uden admin.
    const admins = await tx
      .select({ profileId: clubRoles.profileId })
      .from(clubRoles)
      .where(and(eq(clubRoles.clubId, clubId), eq(clubRoles.role, "admin")))
      .for("update");
    if (admins.length <= 1 && admins.some((a) => a.profileId === profileId)) {
      throw new Error("Foreningen skal have mindst én admin");
    }
    await tx
      .delete(clubRoles)
      .where(and(eq(clubRoles.clubId, clubId), eq(clubRoles.profileId, profileId), eq(clubRoles.role, "admin")));
  });
}

export async function createTeam(db: Db, ctx: AccessContext, clubId: string, name: string, season?: string) {
  assertCan(ctx, { action: "team.create", clubId });
  const [team] = await db.insert(teams).values({ clubId, name, season, inviteCode: newInviteCode() }).returning();
  return team;
}

/** Trænere må tilføje spillere. Kun admin må udpege trænere. */
export async function addTeamMember(
  db: Db,
  ctx: AccessContext,
  teamId: string,
  profileId: string,
  role: "coach" | "player",
) {
  const team = await loadTeamFacts(db, teamId);
  assertCan(ctx, { action: role === "coach" ? "team.coaches.manage" : "team.players.manage", team });
  const [member] = await db
    .select()
    .from(clubMemberships)
    .where(and(eq(clubMemberships.clubId, team.clubId), eq(clubMemberships.profileId, profileId)));
  if (!member) throw new Error("Profilen skal være medlem af foreningen først");
  await db.insert(teamMembers).values({ teamId, profileId, role }).onConflictDoNothing();
  if (role === "player") await applyTeamDefaultFee(db, teamId, profileId);
}

export async function removeTeamMember(
  db: Db,
  ctx: AccessContext,
  teamId: string,
  profileId: string,
  role: "coach" | "player",
) {
  const team = await loadTeamFacts(db, teamId);
  assertCan(ctx, { action: role === "coach" ? "team.coaches.manage" : "team.players.manage", team });
  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.profileId, profileId), eq(teamMembers.role, role)));
}

export interface EventInput {
  type: "training" | "match" | "other";
  title: string;
  startsAt: Date;
  endsAt?: Date | null;
  location?: string | null;
  description?: string | null;
  responseDeadline?: Date | null;
}

export async function createEvent(db: Db, ctx: AccessContext, teamId: string, input: EventInput) {
  const team = await loadTeamFacts(db, teamId);
  assertCan(ctx, { action: "event.manage", event: team });
  const [event] = await db
    .insert(events)
    .values({ ...input, teamId, clubId: team.clubId, createdByUserId: ctx.userId })
    .returning();
  return event;
}

/** Meld til eller fra. Virker for egen profil, for sine børn, og for trænere/admins på holdet. */
export async function respondToEvent(
  db: Db,
  ctx: AccessContext,
  eventId: string,
  profileId: string,
  status: "yes" | "no" | "maybe",
  /** undefined bevarer en tidligere besked, fx når træneren blot registrerer fremmøde. */
  comment?: string | null,
) {
  const [event, profile] = await Promise.all([loadEventFacts(db, eventId), loadProfileFacts(db, profileId)]);
  assertCan(ctx, { action: "event.respond", event, profile });
  const values = { eventId, profileId, status, comment: comment ?? null, respondedByUserId: ctx.userId, respondedAt: new Date() };
  const { comment: _, ...withoutComment } = values;
  await db
    .insert(eventResponses)
    .values(values)
    .onConflictDoUpdate({
      target: [eventResponses.eventId, eventResponses.profileId],
      set: comment === undefined ? withoutComment : values,
    });
}

/** Kommende aktiviteter for den profil, man agerer som, med profilens svar. */
export async function listUpcomingEvents(db: Db, ctx: AccessContext, actingProfileId: string, from = new Date(), to?: Date) {
  assertCan(ctx, { action: "profile.actAs", profileId: actingProfileId });
  const myTeams = await db
    .selectDistinct({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.profileId, actingProfileId));
  if (myTeams.length === 0) return [];
  return db
    .select({
      id: events.id,
      type: events.type,
      title: events.title,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      location: events.location,
      responseDeadline: events.responseDeadline,
      cancelledAt: events.cancelledAt,
      teamId: teams.id,
      teamName: teams.name,
      status: eventResponses.status,
      comment: eventResponses.comment,
    })
    .from(events)
    .innerJoin(teams, eq(teams.id, events.teamId))
    .leftJoin(eventResponses, and(eq(eventResponses.eventId, events.id), eq(eventResponses.profileId, actingProfileId)))
    .where(
      and(
        inArray(events.teamId, myTeams.map((t) => t.teamId)),
        gte(events.startsAt, from),
        to ? lt(events.startsAt, to) : undefined,
      ),
    )
    .orderBy(asc(events.startsAt));
}

/** Læsbar oversigt over alle roller login'et har, til profilsiden. */
export async function describeRoles(db: Db, ctx: AccessContext) {
  const [adminRows, teamRows, wardRows] = await Promise.all([
    db
      .select({ club: clubs.name, title: clubRoles.title })
      .from(clubRoles)
      .innerJoin(clubs, eq(clubs.id, clubRoles.clubId))
      .where(eq(clubRoles.profileId, ctx.profileId)),
    db
      .select({ team: teams.name, role: teamMembers.role })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(eq(teamMembers.profileId, ctx.profileId)),
    ctx.wards.size
      ? db.select({ name: profiles.firstName }).from(profiles).where(inArray(profiles.id, [...ctx.wards]))
      : Promise.resolve([]),
  ]);
  return [
    ...adminRows.map((r) => ({ kind: "admin" as const, label: `${r.title ?? "Admin"} i ${r.club}` })),
    ...teamRows.map((r) => ({ kind: r.role, label: `${r.role === "coach" ? "Træner" : "Spiller"} på ${r.team}` })),
    ...wardRows.map((r) => ({ kind: "parent" as const, label: `Forælder til ${r.name}` })),
  ];
}

export * from "./teams";
export * from "./calendar";
export * from "./finance";
export * from "./modules";
export * from "./carpool";
export * from "./tasks";
