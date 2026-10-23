// Kampe og opstilling (modul "matches"): trænerens kampark med opstilling, resultat og kampreferat, og statistik.
// Alle funktioner kalder requireModule() først, så de kun virker på hold der har modulet slået til.
//
// Regler:
//   - Kun trænere og admin laver opstilling, indtaster resultat, mål og kort og skriver referat.
//   - Opstilling og referat er kladder, til trænerne udgiver dem. Først da ser spillere og forældre dem, og opstillingen
//     sendes som besked. Trækkes en opstilling tilbage, er den igen en kladde.
//   - Alle på holdet ser resultat, mål og udgivet referat. Gule og røde kort ser kun trænerne og spillerens egen familie.
//   - Statistik tæller kun spillede kampe (hvor resultatet er indtastet). Alle ser holdets sæson. En spiller eller en forælder
//     ser egne tal; hele holdets tal pr. spiller ser kun trænerne, med mindre holdet har slået rangliste til.
//   - Spillere og børn skal være på holdet som spillere. En kamp er en aktivitet af typen kamp, som ikke er aflyst.
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { events, eventResponses, matchEvents, matchPlayers, matchSheets, profiles, teamMembers } from "../db/schema";
import { can, canActAs, type AccessContext } from "../auth/permissions";
import { notifyUsers, recipientsOfPlayers, type Deliver } from "./notifications";
import { requireModule } from "./modules";

const leads = (ctx: AccessContext, team: { teamId: string; clubId: string }) => can(ctx, { action: "team.manage", team });

export type LineupSlot = "start" | "bench";
export type MatchEventKind = "goal" | "yellow" | "red";

const MAX_MINUTES = 150;
const MAX_GOALS = 99;
const MAX_REPORT = 8000;

async function loadMatch(db: Pick<Db, "select">, eventId: string) {
  const [e] = await db.select().from(events).where(eq(events.id, eventId));
  if (!e) throw new Error("Kampen findes ikke");
  return e;
}

/** Henter kampen, tjekker modulet og at det er en kamp, der ikke er aflyst. */
async function openMatch(db: Db, ctx: AccessContext, eventId: string, write: boolean) {
  const event = await loadMatch(db, eventId);
  const { team, config } = await requireModule(db, ctx, event.teamId, "matches");
  if (event.type !== "match") throw new Error("Opstilling og referat hører til kampe.");
  const lead = leads(ctx, team);
  if (write) {
    if (!lead) throw new Error("Kun trænere og administratorer ændrer opstilling, resultat og referat.");
    if (event.cancelledAt) throw new Error("Kampen er aflyst.");
  }
  return { event, team, config, lead };
}

async function ensureSheet(db: Pick<Db, "insert" | "select">, ctx: AccessContext, event: { id: string; teamId: string }) {
  await db.insert(matchSheets).values({ eventId: event.id, teamId: event.teamId, updatedByUserId: ctx.userId }).onConflictDoNothing();
  const [sheet] = await db.select().from(matchSheets).where(eq(matchSheets.eventId, event.id));
  return sheet;
}

const touch = (ctx: AccessContext) => ({ updatedByUserId: ctx.userId, updatedAt: ctx.now });

async function teamPlayers(db: Pick<Db, "select">, teamId: string) {
  return db
    .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(teamMembers)
    .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "player")))
    .orderBy(asc(profiles.firstName), asc(profiles.lastName));
}

function cleanText(v: string | null | undefined, max: number, label: string) {
  const t = (v ?? "").trim();
  if (t.length > max) throw new Error(`${label} må højst være ${max} tegn.`);
  return t || null;
}

function cleanInt(v: number | null | undefined, min: number, max: number, label: string) {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${label} skal være et helt tal mellem ${min} og ${max}.`);
  return v;
}

// --- Opstilling ---

export interface LineupEntry {
  profileId: string;
  slot: LineupSlot;
  position?: string | null;
}

/**
 * Gemmer opstillingen: erstatter hvem der er med, og hvor. Spillere, der fjernes, mister også deres spilletid. Spilletid og
 * mål for dem, der bliver, røres ikke. Rækkefølgen i listen er rækkefølgen på siden.
 */
export async function saveLineup(
  db: Db,
  ctx: AccessContext,
  eventId: string,
  input: { entries: LineupEntry[]; opponent?: string | null; formation?: string | null },
) {
  const { event, config } = await openMatch(db, ctx, eventId, true);
  const starters = Number(config.startersCount);
  const seen = new Set<string>();
  for (const e of input.entries) {
    if (seen.has(e.profileId)) throw new Error("En spiller kan kun stå én gang i opstillingen.");
    seen.add(e.profileId);
    if (e.slot !== "start" && e.slot !== "bench") throw new Error("Ukendt plads i opstillingen.");
  }
  const onPitch = input.entries.filter((e) => e.slot === "start").length;
  if (onPitch > starters) throw new Error(`Holdet stiller med ${starters} spillere på banen, og der er valgt ${onPitch}.`);
  const roster = new Set((await teamPlayers(db, event.teamId)).map((p) => p.id));
  if (input.entries.some((e) => !roster.has(e.profileId))) throw new Error("Alle i opstillingen skal være spillere på holdet.");
  const rows = input.entries.map((e, i) => ({
    eventId,
    profileId: e.profileId,
    slot: e.slot,
    position: cleanText(e.position, 40, "Positionen"),
    sortOrder: i,
  }));
  const opponent = input.opponent === undefined ? undefined : cleanText(input.opponent, 80, "Modstanderens navn");
  const formation = input.formation === undefined ? undefined : cleanText(input.formation, 20, "Opstillingen");

  await db.transaction(async (tx) => {
    await ensureSheet(tx, ctx, event);
    const keep = rows.map((r) => r.profileId);
    const existing = await tx.select({ profileId: matchPlayers.profileId }).from(matchPlayers).where(eq(matchPlayers.eventId, eventId));
    const drop = existing.map((e) => e.profileId).filter((p) => !keep.includes(p));
    if (drop.length) await tx.delete(matchPlayers).where(and(eq(matchPlayers.eventId, eventId), inArray(matchPlayers.profileId, drop)));
    for (const r of rows) {
      await tx
        .insert(matchPlayers)
        .values(r)
        .onConflictDoUpdate({ target: [matchPlayers.eventId, matchPlayers.profileId], set: { slot: r.slot, position: r.position, sortOrder: r.sortOrder } });
    }
    await tx
      .update(matchSheets)
      .set({ ...(opponent !== undefined ? { opponent } : {}), ...(formation !== undefined ? { formation } : {}), ...touch(ctx) })
      .where(eq(matchSheets.eventId, eventId));
  });
}

/** Udgiv opstillingen til holdet (og send besked) eller træk den tilbage til kladde. */
export async function setLineupPublished(db: Db, ctx: AccessContext, eventId: string, published: boolean, deliver?: Deliver) {
  const { event } = await openMatch(db, ctx, eventId, true);
  const sheet = await ensureSheet(db, ctx, event);
  if (published) {
    const members = await db.select({ profileId: matchPlayers.profileId }).from(matchPlayers).where(eq(matchPlayers.eventId, eventId));
    if (members.length === 0) throw new Error("Vælg spillere til kampen, før opstillingen udgives.");
    if (sheet.lineupPublishedAt) return;
  }
  await db
    .update(matchSheets)
    .set({ lineupPublishedAt: published ? ctx.now : null, ...touch(ctx) })
    .where(eq(matchSheets.eventId, eventId));
  if (published && deliver) {
    const rosterIds = (await teamPlayers(db, event.teamId)).map((p) => p.id);
    await notifyUsers(db, deliver, await recipientsOfPlayers(db, rosterIds, ctx.now), {
      kind: "event_change",
      subject: `Opstillingen er klar: ${event.title}`,
      body: `Træneren har lagt opstillingen til ${event.title} ud. Se den i HoldLiv.`,
      sms: `Opstillingen til ${event.title} er klar.`,
      url: `/hold/${event.teamId}/kampe/${eventId}`,
      eventId,
      dedupeKey: `lineup:${eventId}:${ctx.now.getTime()}`,
    });
  }
}

// --- Resultat, mål og kort ---

function assertStarted(event: { startsAt: Date }, ctx: AccessContext) {
  if (event.startsAt.getTime() > ctx.now.getTime()) throw new Error("Resultatet kan først indtastes, når kampen er begyndt.");
}

/**
 * Indtast eller ret resultatet. Spilletid kan sendes med pr. spiller (minutter); spillere uden angivelse beholder det, de havde.
 * Kampen tæller først i statistikken herefter.
 */
export async function recordResult(
  db: Db,
  ctx: AccessContext,
  eventId: string,
  input: { goalsFor: number; goalsAgainst: number; minutes?: Record<string, number | null> },
) {
  const { event } = await openMatch(db, ctx, eventId, true);
  assertStarted(event, ctx);
  const goalsFor = cleanInt(input.goalsFor, 0, MAX_GOALS, "Antal mål");
  const goalsAgainst = cleanInt(input.goalsAgainst, 0, MAX_GOALS, "Antal mål");
  if (goalsFor === null || goalsAgainst === null) throw new Error("Skriv begge holds mål.");
  const scorers = await db.select({ id: matchEvents.id }).from(matchEvents).where(and(eq(matchEvents.eventId, eventId), eq(matchEvents.kind, "goal")));
  if (scorers.length > goalsFor) throw new Error(`Der er noteret ${scorers.length} mål for jer. Fjern et mål, før resultatet sættes til ${goalsFor}.`);
  const minutes = Object.entries(input.minutes ?? {});
  const inMatch = new Set((await db.select({ p: matchPlayers.profileId }).from(matchPlayers).where(eq(matchPlayers.eventId, eventId))).map((r) => r.p));
  for (const [profileId, m] of minutes) {
    if (!inMatch.has(profileId)) throw new Error("Spilletid kan kun angives for spillere i opstillingen.");
    cleanInt(m, 0, MAX_MINUTES, "Spilletiden");
  }
  await db.transaction(async (tx) => {
    await ensureSheet(tx, ctx, event);
    for (const [profileId, m] of minutes) {
      await tx.update(matchPlayers).set({ minutes: m }).where(and(eq(matchPlayers.eventId, eventId), eq(matchPlayers.profileId, profileId)));
    }
    await tx.update(matchSheets).set({ goalsFor, goalsAgainst, playedAt: ctx.now, ...touch(ctx) }).where(eq(matchSheets.eventId, eventId));
  });
}

/** Fjern resultatet, så kampen ikke længere tæller i statistikken. Mål og kort bliver stående. */
export async function clearResult(db: Db, ctx: AccessContext, eventId: string) {
  const { event } = await openMatch(db, ctx, eventId, true);
  await ensureSheet(db, ctx, event);
  await db.update(matchSheets).set({ goalsFor: null, goalsAgainst: null, playedAt: null, ...touch(ctx) }).where(eq(matchSheets.eventId, eventId));
}

export interface MatchEventInput {
  kind: MatchEventKind;
  /** Målscorer eller den, der fik kortet. Et mål kan stå uden spiller, hvis man ikke ved hvem der scorede. */
  profileId?: string | null;
  assistProfileId?: string | null;
  minute?: number | null;
}

/** Noter et mål for jer, et gult kort eller et rødt kort. Spillerne skal være i opstillingen. */
export async function addMatchEvent(db: Db, ctx: AccessContext, eventId: string, input: MatchEventInput) {
  const { event } = await openMatch(db, ctx, eventId, true);
  assertStarted(event, ctx);
  if (!["goal", "yellow", "red"].includes(input.kind)) throw new Error("Ukendt slags hændelse.");
  const profileId = input.profileId || null;
  const assistProfileId = input.assistProfileId || null;
  if (input.kind !== "goal" && !profileId) throw new Error("Vælg hvem der fik kortet.");
  if (input.kind !== "goal" && assistProfileId) throw new Error("Kun mål kan have en assist.");
  if (profileId && profileId === assistProfileId) throw new Error("Man kan ikke assistere sig selv.");
  const minute = cleanInt(input.minute, 0, MAX_MINUTES, "Minuttet");
  const involved = [profileId, assistProfileId].filter((p): p is string => !!p);
  if (involved.length) {
    const inMatch = new Set((await db.select({ p: matchPlayers.profileId }).from(matchPlayers).where(eq(matchPlayers.eventId, eventId))).map((r) => r.p));
    if (involved.some((p) => !inMatch.has(p))) throw new Error("Spilleren er ikke i opstillingen til kampen.");
  }
  const sheet = await ensureSheet(db, ctx, event);
  if (input.kind === "goal") {
    const existing = await db.select({ id: matchEvents.id }).from(matchEvents).where(and(eq(matchEvents.eventId, eventId), eq(matchEvents.kind, "goal")));
    if (sheet.goalsFor !== null && existing.length >= sheet.goalsFor) {
      throw new Error(`Resultatet er ${sheet.goalsFor}-${sheet.goalsAgainst}, så alle jeres mål er allerede noteret. Ret resultatet først.`);
    }
  }
  const [row] = await db.insert(matchEvents).values({ eventId, kind: input.kind, profileId, assistProfileId, minute }).returning();
  await db.update(matchSheets).set(touch(ctx)).where(eq(matchSheets.eventId, eventId));
  return row;
}

export async function removeMatchEvent(db: Db, ctx: AccessContext, matchEventId: string) {
  const [row] = await db.select().from(matchEvents).where(eq(matchEvents.id, matchEventId));
  if (!row) throw new Error("Hændelsen findes ikke");
  await openMatch(db, ctx, row.eventId, true);
  await db.delete(matchEvents).where(eq(matchEvents.id, matchEventId));
}

// --- Referat ---

/** Gem kampreferatet som kladde, eller udgiv det til holdet. Sendes teksten tom, fjernes referatet. */
export async function saveReport(db: Db, ctx: AccessContext, eventId: string, input: { text: string; publish?: boolean }) {
  const { event } = await openMatch(db, ctx, eventId, true);
  const report = cleanText(input.text, MAX_REPORT, "Referatet");
  if (input.publish && !report) throw new Error("Skriv referatet, før det udgives.");
  await ensureSheet(db, ctx, event);
  const sheet = (await db.select().from(matchSheets).where(eq(matchSheets.eventId, eventId)))[0];
  await db
    .update(matchSheets)
    .set({
      report,
      reportPublishedAt: !report ? null : input.publish ? (sheet.reportPublishedAt ?? ctx.now) : sheet.reportPublishedAt,
      ...touch(ctx),
    })
    .where(eq(matchSheets.eventId, eventId));
}

export async function unpublishReport(db: Db, ctx: AccessContext, eventId: string) {
  const { event } = await openMatch(db, ctx, eventId, true);
  await ensureSheet(db, ctx, event);
  await db.update(matchSheets).set({ reportPublishedAt: null, ...touch(ctx) }).where(eq(matchSheets.eventId, eventId));
}

// --- Visning ---

/** Kampene på holdet med resultat og om opstillingen er klar. Nyeste først. */
export async function listMatches(db: Db, ctx: AccessContext, teamId: string) {
  const { team } = await requireModule(db, ctx, teamId, "matches");
  const lead = leads(ctx, team);
  const rows = await db
    .select({ event: events, sheet: matchSheets })
    .from(events)
    .leftJoin(matchSheets, eq(matchSheets.eventId, events.id))
    .where(and(eq(events.teamId, teamId), eq(events.type, "match")))
    .orderBy(asc(events.startsAt));
  const view = (r: (typeof rows)[number]) => ({
    eventId: r.event.id,
    title: r.event.title,
    startsAt: r.event.startsAt,
    location: r.event.location,
    cancelled: !!r.event.cancelledAt,
    opponent: r.sheet?.opponent ?? null,
    played: !!r.sheet?.playedAt,
    goalsFor: r.sheet?.playedAt ? r.sheet.goalsFor : null,
    goalsAgainst: r.sheet?.playedAt ? r.sheet.goalsAgainst : null,
    lineupPublished: !!r.sheet?.lineupPublishedAt,
    hasReport: !!r.sheet?.reportPublishedAt,
    /** Kun for trænere: der ligger en opstilling eller et referat, som holdet endnu ikke kan se. */
    draft: lead && ((!!r.sheet?.report && !r.sheet.reportPublishedAt) || (!r.sheet?.lineupPublishedAt && !!r.sheet?.opponent)),
  });
  const all = rows.map(view);
  const now = ctx.now.getTime();
  return {
    canManage: lead,
    upcoming: all.filter((m) => !m.played && !m.cancelled && m.startsAt.getTime() >= now - 3 * 3_600_000),
    past: all.filter((m) => m.played || m.cancelled || m.startsAt.getTime() < now - 3 * 3_600_000).reverse(),
  };
}

/**
 * Kampen som den ses af den, der spørger. Trænere ser kladder og alt; andre ser udgivet opstilling, resultat, mål og udgivet referat.
 * Kort ses af trænerne og af spillerens egen familie.
 */
export async function getMatchSheet(db: Db, ctx: AccessContext, eventId: string) {
  const { event, team, config, lead } = await openMatch(db, ctx, eventId, false);
  const [sheet] = await db.select().from(matchSheets).where(eq(matchSheets.eventId, eventId));
  const [roster, lineup, evs, responses] = await Promise.all([
    teamPlayers(db, event.teamId),
    db.select().from(matchPlayers).where(eq(matchPlayers.eventId, eventId)).orderBy(asc(matchPlayers.sortOrder)),
    db.select().from(matchEvents).where(eq(matchEvents.eventId, eventId)).orderBy(asc(matchEvents.minute), asc(matchEvents.createdAt)),
    lead ? db.select({ profileId: eventResponses.profileId, status: eventResponses.status }).from(eventResponses).where(eq(eventResponses.eventId, eventId)) : Promise.resolve([]),
  ]);
  const name = new Map(roster.map((p) => [p.id, `${p.firstName} ${p.lastName}`]));
  const nameOf = (id: string | null) => (id ? (name.get(id) ?? "Tidligere spiller") : null);
  const lineupVisible = lead || !!sheet?.lineupPublishedAt;
  const played = !!sheet?.playedAt;
  const reportVisible = lead || !!sheet?.reportPublishedAt;
  const status = new Map(responses.map((r) => [r.profileId, r.status]));
  return {
    canManage: lead,
    teamId: team.teamId,
    event: { id: event.id, title: event.title, startsAt: event.startsAt, location: event.location, cancelled: !!event.cancelledAt },
    startersCount: Number(config.startersCount),
    opponent: sheet?.opponent ?? null,
    formation: lineupVisible ? (sheet?.formation ?? null) : null,
    lineupPublished: !!sheet?.lineupPublishedAt,
    lineup: lineupVisible
      ? lineup.map((l) => ({
          profileId: l.profileId,
          name: nameOf(l.profileId)!,
          slot: l.slot as LineupSlot,
          position: l.position,
          minutes: played || lead ? l.minutes : null,
          mine: canActAs(ctx, l.profileId),
        }))
      : [],
    /** Kun for trænere: hele truppen med svar, så man ser hvem der kommer. */
    squad: lead
      ? roster.map((p) => ({
          profileId: p.id,
          name: `${p.firstName} ${p.lastName}`,
          response: status.get(p.id) ?? null,
          slot: (lineup.find((l) => l.profileId === p.id)?.slot ?? null) as LineupSlot | null,
        }))
      : [],
    played,
    goalsFor: played ? sheet!.goalsFor : null,
    goalsAgainst: played ? sheet!.goalsAgainst : null,
    events: played || lead
      ? evs
          .filter((e) => e.kind === "goal" || lead || (e.profileId && canActAs(ctx, e.profileId)))
          .map((e) => ({
            id: e.id,
            kind: e.kind as MatchEventKind,
            minute: e.minute,
            playerName: nameOf(e.profileId),
            assistName: nameOf(e.assistProfileId),
          }))
      : [],
    report: reportVisible ? (sheet?.report ?? null) : null,
    reportPublished: !!sheet?.reportPublishedAt,
  };
}

// --- Statistik ---

export interface PlayerStats {
  profileId: string;
  name: string;
  matches: number;
  starts: number;
  minutes: number;
  goals: number;
  assists: number;
  yellow: number;
  red: number;
}

/**
 * Sæsonen for holdet: sejre, uafgjorte og nederlag, mål og de spillede kampe. Pr. spiller: kampe, starter, spilletid,
 * mål, assists og kort. En spiller har spillet en kamp, hvis vedkommende startede, eller sad på bænken og fik spilletid.
 */
export async function getTeamStats(db: Db, ctx: AccessContext, teamId: string) {
  const { team, config } = await requireModule(db, ctx, teamId, "matches");
  const lead = leads(ctx, team);
  const sheets = await db
    .select({ sheet: matchSheets, title: events.title, startsAt: events.startsAt })
    .from(matchSheets)
    .innerJoin(events, eq(events.id, matchSheets.eventId))
    .where(and(eq(matchSheets.teamId, teamId), isNotNull(matchSheets.playedAt), eq(events.type, "match"), isNull(events.cancelledAt)))
    .orderBy(asc(events.startsAt));
  const live = sheets;
  const eventIds = live.map((s) => s.sheet.eventId);
  const [roster, lineups, evs] = await Promise.all([
    teamPlayers(db, teamId),
    eventIds.length ? db.select().from(matchPlayers).where(inArray(matchPlayers.eventId, eventIds)) : Promise.resolve([]),
    eventIds.length ? db.select().from(matchEvents).where(inArray(matchEvents.eventId, eventIds)) : Promise.resolve([]),
  ]);

  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  const results = live.map((s) => {
    const gf = s.sheet.goalsFor ?? 0;
    const ga = s.sheet.goalsAgainst ?? 0;
    goalsFor += gf;
    goalsAgainst += ga;
    if (gf > ga) wins++;
    else if (gf === ga) draws++;
    else losses++;
    return { eventId: s.sheet.eventId, title: s.title, startsAt: s.startsAt, opponent: s.sheet.opponent, goalsFor: gf, goalsAgainst: ga, outcome: gf > ga ? ("win" as const) : gf === ga ? ("draw" as const) : ("loss" as const) };
  });

  const cardsVisible = (profileId: string) => lead || canActAs(ctx, profileId);
  const players: PlayerStats[] = roster.map((p) => {
    const mine = lineups.filter((l) => l.profileId === p.id);
    const played = mine.filter((l) => l.slot === "start" || (l.minutes ?? 0) > 0);
    return {
      profileId: p.id,
      name: `${p.firstName} ${p.lastName}`,
      matches: played.length,
      starts: mine.filter((l) => l.slot === "start").length,
      minutes: mine.reduce((a, l) => a + (l.minutes ?? 0), 0),
      goals: evs.filter((e) => e.kind === "goal" && e.profileId === p.id).length,
      assists: evs.filter((e) => e.kind === "goal" && e.assistProfileId === p.id).length,
      // Kort ser kun trænerne og spillerens egen familie, også når ranglisten er slået til.
      yellow: cardsVisible(p.id) ? evs.filter((e) => e.kind === "yellow" && e.profileId === p.id).length : 0,
      red: cardsVisible(p.id) ? evs.filter((e) => e.kind === "red" && e.profileId === p.id).length : 0,
    };
  });
  const everyone = lead || config.showRankings === true;
  return {
    canManage: lead,
    rankingsShown: everyone,
    record: { played: live.length, wins, draws, losses, goalsFor, goalsAgainst },
    results: results.reverse(),
    /** Trænere og hold med rangliste ser alle; ellers kun egne og børnenes tal. */
    players: players.filter((p) => everyone || canActAs(ctx, p.profileId)).sort((a, b) => b.goals - a.goals || b.assists - a.assists || b.matches - a.matches || a.name.localeCompare(b.name, "da")),
  };
}
