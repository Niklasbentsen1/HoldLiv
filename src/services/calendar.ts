// Kalender: træninger, kampe og faste træningsserier, og trænerens overblik over svar og fremmøde.
import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import { eventResponses, events, profiles, teamMembers, teams } from "../db/schema";
import { assertCan, can, canActAs, type AccessContext } from "../auth/permissions";
import { loadEventFacts, loadTeamFacts, loadTeamMemberIds } from "../auth/context";
import { addLocalDays } from "../lib/time";
import type { EventInput } from "./index";

export const MAX_SERIES_LENGTH = 52;
export type ResponseStatus = "yes" | "no" | "maybe";

/** Fast ugentlig aktivitet, fx træning hver tirsdag kl. 17 frem til sæsonens slutning. */
export async function createEventSeries(db: Db, ctx: AccessContext, teamId: string, input: EventInput, until: Date) {
  const team = await loadTeamFacts(db, teamId);
  assertCan(ctx, { action: "event.manage", event: team });
  const seriesId = randomUUID();
  const rows = [];
  for (let week = 0; week < MAX_SERIES_LENGTH; week++) {
    const startsAt = addLocalDays(input.startsAt, week * 7);
    if (startsAt.getTime() > until.getTime()) break;
    // Slut og svarfrist flyttes med, så de ligger lige så langt fra starten hver uge.
    const shift = (d?: Date | null) => (d ? new Date(startsAt.getTime() + (d.getTime() - input.startsAt.getTime())) : null);
    rows.push({
      ...input,
      startsAt,
      endsAt: shift(input.endsAt),
      responseDeadline: shift(input.responseDeadline),
      teamId,
      clubId: team.clubId,
      seriesId,
      createdByUserId: ctx.userId,
    });
  }
  if (rows.length === 0) throw new Error("Slutdatoen ligger før første aktivitet");
  return db.insert(events).values(rows).returning();
}

export async function updateEvent(db: Db, ctx: AccessContext, eventId: string, patch: Partial<EventInput>) {
  assertCan(ctx, { action: "event.manage", event: await loadEventFacts(db, eventId) });
  const [e] = await db.update(events).set(patch).where(eq(events.id, eventId)).returning();
  return e;
}

/** Aflys (eller genopret) én aktivitet, eller den og resten af serien. */
export async function setEventCancelled(
  db: Db,
  ctx: AccessContext,
  eventId: string,
  cancelled: boolean,
  scope: "one" | "following" = "one",
) {
  assertCan(ctx, { action: "event.manage", event: await loadEventFacts(db, eventId) });
  const [e] = await db.select().from(events).where(eq(events.id, eventId));
  const where =
    scope === "following" && e.seriesId
      ? and(eq(events.seriesId, e.seriesId), gte(events.startsAt, e.startsAt))
      : eq(events.id, eventId);
  return db
    .update(events)
    .set({ cancelledAt: cancelled ? ctx.now : null })
    // Kun aktiviteter, der faktisk skifter tilstand, så en gentaget aflysning ikke rører noget (og ikke giver nye beskeder).
    .where(and(where, cancelled ? isNull(events.cancelledAt) : isNotNull(events.cancelledAt)))
    .returning({ id: events.id });
}

/** Holdets kalender med antal svar pr. aktivitet. */
export async function listTeamEvents(db: Db, ctx: AccessContext, teamId: string, from: Date, to?: Date) {
  const team = await loadTeamFacts(db, teamId);
  assertCan(ctx, { action: "team.view", team, memberProfileIds: await loadTeamMemberIds(db, teamId) });
  const rows = await db
    .select({
      id: events.id,
      type: events.type,
      title: events.title,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      location: events.location,
      seriesId: events.seriesId,
      cancelledAt: events.cancelledAt,
      yes: sql<number>`count(*) filter (where ${eventResponses.status} = 'yes')::int`,
      maybe: sql<number>`count(*) filter (where ${eventResponses.status} = 'maybe')::int`,
      no: sql<number>`count(*) filter (where ${eventResponses.status} = 'no')::int`,
    })
    .from(events)
    .leftJoin(eventResponses, eq(eventResponses.eventId, events.id))
    .where(and(eq(events.teamId, teamId), gte(events.startsAt, from), to ? lt(events.startsAt, to) : undefined))
    .groupBy(events.id)
    .orderBy(asc(events.startsAt));
  return rows;
}

/**
 * En aktivitet med holdets spillere og deres svar.
 * Alle på holdet kan se hvem der kommer. Kommentarer ("syg", "til fødselsdag") ser kun
 * trænere/admins og spilleren selv eller forældrene.
 */
export async function getEventDetail(db: Db, ctx: AccessContext, eventId: string) {
  const facts = await loadEventFacts(db, eventId);
  assertCan(ctx, { action: "team.view", team: facts, memberProfileIds: await loadTeamMemberIds(db, facts.teamId) });
  const leads = can(ctx, { action: "event.manage", event: facts });

  const responder = alias(profiles, "responder");
  const [[event], roster] = await Promise.all([
    db
      .select({ event: events, teamName: teams.name })
      .from(events)
      .innerJoin(teams, eq(teams.id, events.teamId))
      .where(eq(events.id, eventId)),
    db
      .select({
        profileId: profiles.id,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        status: eventResponses.status,
        comment: eventResponses.comment,
        respondedAt: eventResponses.respondedAt,
        respondedByUserId: eventResponses.respondedByUserId,
        responderName: responder.firstName,
        responderProfileId: responder.id,
      })
      .from(teamMembers)
      .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
      .leftJoin(eventResponses, and(eq(eventResponses.eventId, eventId), eq(eventResponses.profileId, teamMembers.profileId)))
      .leftJoin(responder, eq(responder.userId, eventResponses.respondedByUserId))
      .where(and(eq(teamMembers.teamId, facts.teamId), eq(teamMembers.role, "player")))
      .orderBy(asc(profiles.firstName)),
  ]);

  const players = roster.map((r) => {
    const mine = canActAs(ctx, r.profileId);
    const seeDetails = leads || mine;
    return {
      profileId: r.profileId,
      name: `${r.firstName} ${r.lastName}`,
      firstName: r.firstName,
      status: r.status,
      mine,
      canRespond: can(ctx, {
        action: "event.respond",
        event: facts,
        profile: { profileId: r.profileId, clubIds: [facts.clubId], teamIds: [facts.teamId] },
      }),
      comment: seeDetails ? r.comment : null,
      respondedAt: seeDetails ? r.respondedAt : null,
      // "Meldt fra af Niklas", når det ikke var spilleren selv der svarede.
      respondedBy: seeDetails && r.responderProfileId && r.responderProfileId !== r.profileId ? r.responderName : null,
    };
  });

  const group = (s: ResponseStatus | null) => players.filter((p) => p.status === s);
  return {
    ...event.event,
    teamName: event.teamName,
    canManage: leads,
    responsesClosed: ctx.now.getTime() >= (facts.responseDeadline ?? event.event.startsAt).getTime(),
    players,
    groups: { yes: group("yes"), maybe: group("maybe"), no: group("no"), none: group(null) },
  };
}

/**
 * Trænerens fremmødeoverblik: spillere × aktiviteter i en periode, med fremmødeprocent
 * for de aktiviteter der allerede har fundet sted. Aflyste aktiviteter tæller ikke med.
 */
export async function getAttendanceOverview(db: Db, ctx: AccessContext, teamId: string, from: Date, to: Date) {
  const team = await loadTeamFacts(db, teamId);
  assertCan(ctx, { action: "team.manage", team });
  const [eventRows, players] = await Promise.all([
    db
      .select({ id: events.id, type: events.type, title: events.title, startsAt: events.startsAt })
      .from(events)
      .where(and(eq(events.teamId, teamId), isNull(events.cancelledAt), gte(events.startsAt, from), lt(events.startsAt, to)))
      .orderBy(asc(events.startsAt)),
    db
      .select({ profileId: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
      .from(teamMembers)
      .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "player")))
      .orderBy(asc(profiles.firstName)),
  ]);
  const responses = eventRows.length
    ? await db
        .select({ eventId: eventResponses.eventId, profileId: eventResponses.profileId, status: eventResponses.status })
        .from(eventResponses)
        .where(inArray(eventResponses.eventId, eventRows.map((e) => e.id)))
    : [];
  const key = (e: string, p: string) => `${e}:${p}`;
  const status = new Map(responses.map((r) => [key(r.eventId, r.profileId), r.status]));
  const past = eventRows.filter((e) => e.startsAt.getTime() < ctx.now.getTime());

  return {
    events: eventRows.map((e) => ({ ...e, past: e.startsAt.getTime() < ctx.now.getTime() })),
    players: players.map((p) => {
      const cells = eventRows.map((e) => status.get(key(e.id, p.profileId)) ?? null);
      const attended = past.filter((e) => status.get(key(e.id, p.profileId)) === "yes").length;
      return {
        ...p,
        cells,
        attended,
        pastCount: past.length,
        rate: past.length ? Math.round((attended / past.length) * 100) : null,
        unanswered: eventRows.filter((e) => !past.includes(e) && !status.has(key(e.id, p.profileId))).length,
      };
    }),
  };
}
