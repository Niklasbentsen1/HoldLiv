// Medlemstal til kommunens tilskud, DIF/DGI og foreningens eget regnskab (arbejdsplan 31, "CFR-indberetning").
// HoldLiv indberetter ikke selv, og gemmer hverken CPR-numre eller adresser. Rapporten giver de tal, der kan indtastes eller
// uploades i kommunens og forbundenes portaler: aktive medlemmer pr. aldersgruppe på en valgt dato og spillere pr. hold.
// Medlemmer uden fødselsdato står for sig, så man kan rette dem, før tallet indberettes.
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubMemberships, profiles, teamMembers, teams } from "../db/schema";
import { assertCan, type AccessContext } from "../auth/permissions";
import { ageOn } from "../lib/age";
import { logAudit } from "./audit";
import { csvCell } from "./finance";

export const AGE_BANDS: { key: string; label: string; from: number; to: number }[] = [
  { key: "0-5", label: "0–5 år", from: 0, to: 5 },
  { key: "6-12", label: "6–12 år", from: 6, to: 12 },
  { key: "13-18", label: "13–18 år", from: 13, to: 18 },
  { key: "19-24", label: "19–24 år", from: 19, to: 24 },
  { key: "25-59", label: "25–59 år", from: 25, to: 59 },
  { key: "60+", label: "60 år og over", from: 60, to: 200 },
];

export type StatsScope = "all" | "active";

/**
 * Medlemmer på en dato: indmeldt senest den dag (dansk tid) og ikke udmeldt til og med dagen. Et medlem, der først melder sig ud
 * senere, tæller altså med, så tallene pr. 31. december stadig passer, når de indberettes i januar. Ventelisteplads er ikke medlemskab.
 * Med scope "active" tæller kun dem, der har et kontingent eller spiller på et hold, så forældre, der kun er medlemmer for at
 * håndtere børnene, ikke kommer med i tallet.
 */
export async function memberStats(db: Db, ctx: AccessContext, clubId: string, asOf: string, scope: StatsScope = "all") {
  assertCan(ctx, { action: "finance.manage", clubId });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf))) throw new Error("Vælg en dato.");
  // Første tidspunkt efter dagen, i dansk tid.
  const nextDay = sql`((${asOf}::date + 1)::timestamp at time zone 'Europe/Copenhagen')`;
  const rows = await db
    .select({ profileId: profiles.id, birthDate: profiles.birthDate })
    .from(clubMemberships)
    .innerJoin(profiles, eq(profiles.id, clubMemberships.profileId))
    .where(
      and(
        eq(clubMemberships.clubId, clubId),
        ne(clubMemberships.status, "waitlist"),
        sql`${clubMemberships.joinedAt} < ${nextDay}`,
        sql`(${clubMemberships.leftAt} >= ${nextDay} or (${clubMemberships.leftAt} is null and ${clubMemberships.status} = 'active'))`,
        scope === "active"
          ? sql`(${clubMemberships.feeId} is not null or exists (select 1 from team_members tm join teams t on t.id = tm.team_id where tm.profile_id = ${clubMemberships.profileId} and tm.role = 'player' and t.club_id = ${clubId}))`
          : undefined,
      ),
    );
  const bands = AGE_BANDS.map((b) => ({ ...b, count: 0 }));
  let unknown = 0;
  let under25 = 0;
  let under18 = 0;
  for (const r of rows) {
    if (!r.birthDate) {
      unknown++;
      continue;
    }
    const age = ageOn(r.birthDate, asOf);
    if (age < 0) {
      unknown++;
      continue;
    }
    const band = bands.find((b) => age >= b.from && age <= b.to);
    if (band) band.count++;
    if (age < 25) under25++;
    if (age < 18) under18++;
  }
  // Holdenes spillere er dem, der er på holdet nu (hold har ingen datoer), blandt de medlemmer, der tæller på datoen.
  const perTeam = await db
    .select({ teamId: teams.id, name: teams.name, season: teams.season, players: sql<number>`count(distinct ${teamMembers.profileId})::int` })
    .from(teams)
    .leftJoin(
      teamMembers,
      and(
        eq(teamMembers.teamId, teams.id),
        eq(teamMembers.role, "player"),
        sql`${teamMembers.profileId} in (select profile_id from club_memberships where club_id = ${clubId} and status <> 'waitlist' and created_at < ${nextDay} and (left_at >= ${nextDay} or (left_at is null and status = 'active')))`,
      ),
    )
    .where(eq(teams.clubId, clubId))
    .groupBy(teams.id, teams.name, teams.season)
    .orderBy(asc(teams.name));
  return { asOf, scope, total: rows.length, bands, unknown, under25, under18, perTeam };
}

/** Tallene som regneark (semikolon, BOM for Excel). */
export async function memberStatsCsv(db: Db, ctx: AccessContext, clubId: string, asOf: string, scope: StatsScope = "all") {
  const s = await memberStats(db, ctx, clubId, asOf, scope);
  await logAudit(db, { action: "memberstats.exported", clubId, actorUserId: ctx.userId, detail: { asOf, scope } });
  const line = (...cells: unknown[]) => cells.map(csvCell).join(";");
  const lines = [
    line("Medlemstal pr.", s.asOf),
    line("Opgørelse", scope === "active" ? "Kun medlemmer med kontingent eller plads på et hold" : "Alle medlemmer"),
    line("Aldersgruppe", "Antal"),
    ...s.bands.map((b) => line(b.label, b.count)),
    line("Uden fødselsdato", s.unknown),
    line("I alt", s.total),
    line("Heraf under 18 år", s.under18),
    line("Heraf under 25 år", s.under25),
    "",
    line("Hold (nuværende spillere blandt medlemmerne)", "Sæson", "Spillere"),
    ...s.perTeam.map((t) => line(t.name, t.season ?? "", t.players)),
  ];
  return "﻿" + lines.join("\r\n") + "\r\n";
}
