// Kalenderabonnement: et hemmeligt link pr. login, som telefonens kalender henter aktiviteter fra.
// Feedet viser holdene, man selv spiller på, børnenes hold (under 18) og de hold, man træner.
import { randomBytes } from "node:crypto";
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import type { Db } from "../db/client";
import { calendarFeeds, events, profiles, teamMembers, teams } from "../db/schema";
import { loadAccessContext } from "../auth/context";
import type { AccessContext } from "../auth/permissions";
import { TYPE_LABEL } from "../lib/format";
import { buildCalendar, type IcsEvent } from "../lib/ics";

const newToken = () => randomBytes(24).toString("base64url");
const DAY = 86_400_000;

export async function getFeedToken(db: Db, ctx: AccessContext) {
  const [row] = await db
    .insert(calendarFeeds)
    .values({ userId: ctx.userId, token: newToken() })
    .onConflictDoUpdate({ target: calendarFeeds.userId, set: { userId: ctx.userId } })
    .returning({ token: calendarFeeds.token });
  return row.token;
}

/** Gør det gamle link ubrugeligt og giver et nyt. */
export async function resetFeedToken(db: Db, ctx: AccessContext) {
  const [row] = await db
    .insert(calendarFeeds)
    .values({ userId: ctx.userId, token: newToken() })
    .onConflictDoUpdate({ target: calendarFeeds.userId, set: { token: newToken(), createdAt: new Date() } })
    .returning({ token: calendarFeeds.token });
  return row.token;
}

/** iCalendar-teksten til et link, eller null hvis linket ikke findes (eller er nulstillet). */
export async function buildFeed(db: Db, token: string, baseUrl: string, now = new Date()): Promise<string | null> {
  const [feed] = await db.select({ userId: calendarFeeds.userId }).from(calendarFeeds).where(eq(calendarFeeds.token, token));
  if (!feed) return null;
  const ctx = await loadAccessContext(db, feed.userId, now).catch(() => null);
  if (!ctx) return null;

  // Hvem jeg følger: mig selv og mine børn under 18.
  const followed = [ctx.profileId, ...ctx.wards];
  const playing = await db
    .select({ teamId: teamMembers.teamId, profileId: profiles.id, firstName: profiles.firstName })
    .from(teamMembers)
    .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
    .where(and(inArray(teamMembers.profileId, followed), eq(teamMembers.role, "player")));
  const namesByTeam = new Map<string, string[]>();
  for (const p of playing) namesByTeam.set(p.teamId, [...(namesByTeam.get(p.teamId) ?? []), p.profileId === ctx.profileId ? "dig" : p.firstName]);
  const teamIds = [...new Set([...namesByTeam.keys(), ...ctx.coachTeams])];

  const [rows, myName] = await Promise.all([
    teamIds.length
      ? db
          .select({ e: events, teamName: teams.name })
          .from(events)
          .innerJoin(teams, eq(teams.id, events.teamId))
          .where(and(inArray(events.teamId, teamIds), gte(events.startsAt, new Date(now.getTime() - 30 * DAY)), lte(events.startsAt, new Date(now.getTime() + 400 * DAY))))
          .orderBy(asc(events.startsAt))
      : [],
    db.select({ firstName: profiles.firstName }).from(profiles).where(eq(profiles.id, ctx.profileId)),
  ]);

  const items: IcsEvent[] = rows.map(({ e, teamName }) => {
    const names = namesByTeam.get(e.teamId) ?? [];
    const kind = e.title.toLowerCase().startsWith(TYPE_LABEL[e.type].toLowerCase()) ? e.title : `${TYPE_LABEL[e.type]}: ${e.title}`;
    const who = names.length ? ` (${names.join(" og ")})` : "";
    const lines = [e.description, `Svar og se mere: ${baseUrl}/aktivitet/${e.id}`].filter(Boolean) as string[];
    return {
      uid: `${e.id}@holdliv`,
      start: e.startsAt,
      end: e.endsAt ?? new Date(e.startsAt.getTime() + 90 * 60_000),
      stamp: e.createdAt,
      summary: `${teamName}: ${kind}${who}`,
      location: e.location,
      description: lines.join("\n\n"),
      url: `${baseUrl}/aktivitet/${e.id}`,
      cancelled: !!e.cancelledAt,
    };
  });
  return buildCalendar(`HoldLiv, ${myName[0]?.firstName ?? ""}`.trim().replace(/,$/, ""), items);
}
