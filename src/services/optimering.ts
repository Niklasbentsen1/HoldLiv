// Holdoptimering: ud fra kapacitet, ventelister, trænere og træningstider foreslår HoldLiv nye hold, flere pladser,
// trænere og ledige tider. Forslagene er regelbaserede og kan forklares; en AI-rådgiver (lib/advisor) kan binde dem sammen.
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { events, profiles, teamMembers, teams, teamWaitlist, clubs } from "../db/schema";
import { assertCan, type AccessContext } from "../auth/permissions";
import { ageOn } from "../lib/age";
import { localDate } from "../lib/money";
import type { Advisor, AdvisorInput } from "../lib/advisor";
import { logAudit } from "./audit";

/** Mindste antal ventende i samme aldersgruppe, før et nyt hold er værd at foreslå. */
export const MIN_NEW_TEAM = 6;
/** Rimeligt antal spillere pr. træner. */
export const PLAYERS_PER_COACH = 14;
/** Aldersgrupper regnes inden for så mange år. */
export const AGE_SPAN = 2;
const WEEKS_BACK = 8;
const SLOT_HOURS = [16, 17, 18];
const WEEKDAYS = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];

export interface TeamProfile {
  teamId: string;
  name: string;
  capacity: number | null;
  players: number;
  waiting: number;
  coaches: number;
  ageMin: number | null;
  ageMax: number | null;
}

export interface Suggestion {
  kind: "ny_hold" | "hæv_kapacitet" | "mangler_traener" | "ledig_tid";
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  teamIds: string[];
}

const range = (min: number | null, max: number | null) => (min === null || max === null ? "ukendt alder" : min === max ? `${min} år` : `${min}-${max} år`);

const tz = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", weekday: "short", hour: "numeric", hour12: false });
function slotOf(d: Date): { weekday: number; hour: number } {
  const parts = Object.fromEntries(tz.formatToParts(d).map((p) => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { weekday, hour: Number(parts.hour) % 24 };
}

/** Grupperer ventende i aldersgrupper på højst AGE_SPAN år. */
export function groupByAge(items: { age: number; teamId: string }[]) {
  const sorted = [...items].sort((a, b) => a.age - b.age);
  const groups: { ages: number[]; teamIds: Set<string> }[] = [];
  for (const it of sorted) {
    const g = groups[groups.length - 1];
    if (g && it.age - g.ages[0] <= AGE_SPAN) {
      g.ages.push(it.age);
      g.teamIds.add(it.teamId);
    } else groups.push({ ages: [it.age], teamIds: new Set([it.teamId]) });
  }
  return groups;
}

export async function analyseClub(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  const today = localDate(ctx.now);
  const clubTeams = await db.select({ id: teams.id, name: teams.name, capacity: teams.capacity }).from(teams).where(eq(teams.clubId, clubId)).orderBy(asc(teams.name));
  const ids = clubTeams.map((t) => t.id);
  if (ids.length === 0) return { teams: [] as TeamProfile[], suggestions: [] as Suggestion[] };

  const [members, waiting, trainings] = await Promise.all([
    db
      .select({ teamId: teamMembers.teamId, role: teamMembers.role, birthDate: profiles.birthDate })
      .from(teamMembers)
      .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
      .where(inArray(teamMembers.teamId, ids)),
    db
      .select({ teamId: teamWaitlist.teamId, birthDate: profiles.birthDate })
      .from(teamWaitlist)
      .innerJoin(profiles, eq(profiles.id, teamWaitlist.profileId))
      .where(inArray(teamWaitlist.teamId, ids)),
    db
      .select({ location: events.location, startsAt: events.startsAt, teamId: events.teamId })
      .from(events)
      .where(and(inArray(events.teamId, ids), eq(events.type, "training"), gte(events.startsAt, new Date(ctx.now.getTime() - WEEKS_BACK * 7 * 86_400_000)))),
  ]);

  const profilesOut: TeamProfile[] = clubTeams.map((t) => {
    const mine = members.filter((m) => m.teamId === t.id);
    const players = mine.filter((m) => m.role === "player");
    const ages = players.flatMap((p) => (p.birthDate ? [ageOn(p.birthDate, today)] : []));
    return {
      teamId: t.id,
      name: t.name,
      capacity: t.capacity,
      players: players.length,
      waiting: waiting.filter((w) => w.teamId === t.id).length,
      coaches: mine.filter((m) => m.role === "coach").length,
      ageMin: ages.length ? Math.min(...ages) : null,
      ageMax: ages.length ? Math.max(...ages) : null,
    };
  });

  const suggestions: Suggestion[] = [];

  for (const t of profilesOut) {
    if (t.coaches === 0 && t.players > 0)
      suggestions.push({ kind: "mangler_traener", severity: "high", title: `${t.name} mangler en træner`, detail: `${t.players} spillere og ingen træner. Udpeg en træner, før holdet kan fungere.`, teamIds: [t.teamId] });
  }

  // Nyt hold: ventende i samme aldersgruppe på tværs af hold.
  const waitingAges = waiting.flatMap((w) => (w.birthDate ? [{ age: ageOn(w.birthDate, today), teamId: w.teamId }] : []));
  const coveredByNewTeam = new Set<string>();
  for (const g of groupByAge(waitingAges)) {
    if (g.ages.length < MIN_NEW_TEAM) continue;
    const names = [...g.teamIds].map((id) => profilesOut.find((t) => t.teamId === id)!.name);
    suggestions.push({
      kind: "ny_hold",
      severity: "high",
      title: `Opret et nyt hold for ${range(Math.min(...g.ages), Math.max(...g.ages))}`,
      detail: `${g.ages.length} børn venter på ${names.join(", ")}. Det er nok til et nyt hold. Find en træner og en fast træningstid.`,
      teamIds: [...g.teamIds],
    });
    for (const id of g.teamIds) coveredByNewTeam.add(id);
  }

  // Flere pladser: fuldt hold med ventende, hvor trænerne kan klare flere.
  for (const t of profilesOut) {
    if (t.waiting === 0 || coveredByNewTeam.has(t.teamId)) continue;
    const want = t.players + t.waiting;
    const needCoaches = Math.ceil(want / PLAYERS_PER_COACH);
    if (t.coaches >= needCoaches && t.capacity !== null && t.capacity < want) {
      suggestions.push({ kind: "hæv_kapacitet", severity: "medium", title: `Hæv ${t.name} fra ${t.capacity} til ${want} pladser`, detail: `${t.waiting} venter, og ${t.coaches} ${t.coaches === 1 ? "træner" : "trænere"} kan klare ${want} spillere (højst ${PLAYERS_PER_COACH} pr. træner).`, teamIds: [t.teamId] });
    } else if (t.coaches < needCoaches) {
      suggestions.push({ kind: "mangler_traener", severity: "medium", title: `${t.name} skal bruge ${needCoaches - t.coaches} ekstra ${needCoaches - t.coaches === 1 ? "træner" : "trænere"} for at tage de ${t.waiting} ventende`, detail: `Med ${want} spillere bør der være ${needCoaches} ${needCoaches === 1 ? "træner" : "trænere"}; der er ${t.coaches}.`, teamIds: [t.teamId] });
    }
  }

  // Ledige tider: kun relevant, når der er et nyt hold eller flere pladser at placere.
  if (suggestions.some((s) => s.kind === "ny_hold" || s.kind === "hæv_kapacitet")) {
    const used = new Map<string, Set<string>>();
    for (const e of trainings) {
      if (!e.location) continue;
      const { weekday, hour } = slotOf(e.startsAt);
      (used.get(e.location) ?? used.set(e.location, new Set()).get(e.location)!).add(`${weekday}-${hour}`);
    }
    for (const [location, slots] of used) {
      const free: string[] = [];
      for (const weekday of [1, 2, 3, 4]) {
        const hours = SLOT_HOURS.filter((h) => !slots.has(`${weekday}-${h}`));
        if (hours.length === SLOT_HOURS.length) free.push(`${WEEKDAYS[weekday]} kl. ${hours[0]}-${hours[hours.length - 1] + 1}`);
      }
      if (free.length > 0) suggestions.push({ kind: "ledig_tid", severity: "low", title: `${location} er ledig ${free.slice(0, 3).join(", ")}`, detail: `Ingen af holdene har trænet der på de tidspunkter de seneste ${WEEKS_BACK} uger. Tjek med foreningen, at banen er til rådighed.`, teamIds: [] });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  suggestions.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { teams: profilesOut, suggestions };
}

/** Holdnavne er fritekst og kan indeholde personnavne, så de erstattes med "Hold 1…" før de sendes, og sættes ind igen i svaret. */
export function anonymiseTeams(names: string[]) {
  const order = names.map((name, i) => ({ name, alias: `Hold ${i + 1}` })).sort((a, b) => b.name.length - a.name.length);
  const swap = (text: string, from: "name" | "alias", to: "name" | "alias") => order.reduce((acc, e) => (e[from] ? acc.split(e[from]).join(e[to]) : acc), text);
  return {
    alias: (name: string) => order.find((e) => e.name === name)!.alias,
    out: (text: string) => swap(text, "name", "alias"),
    back: (text: string) => swap(text, "alias", "name"),
  };
}

/** Beder rådgiveren om en samlet anbefaling. Kun sammentalte tal og anonymiserede holdnavne forlader HoldLiv, aldrig personer. */
export async function adviseClub(db: Db, ctx: AccessContext, clubId: string, advisor: Advisor) {
  const { teams: t, suggestions } = await analyseClub(db, ctx, clubId);
  const [club] = await db.select({ name: clubs.name }).from(clubs).where(eq(clubs.id, clubId));
  const anon = anonymiseTeams(t.map((x) => x.name));
  const input: AdvisorInput = {
    club: club.name,
    teams: t.map(({ teamId, ...rest }) => ({ ...rest, name: anon.alias(rest.name) })),
    suggestions: suggestions.map(({ kind, title, detail }) => ({ kind, title: anon.out(title), detail: anon.out(detail) })),
  };
  const text = anon.back(await advisor(input));
  await logAudit(db, { action: "ai.advice", clubId, actorUserId: ctx.userId });
  return text;
}
