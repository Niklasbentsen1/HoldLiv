// Medlemstal til kommunens tilskud, DIF/DGI og foreningens eget regnskab (arbejdsplan 31, "CFR-indberetning").
// HoldLiv indberetter ikke selv, og gemmer hverken CPR-numre eller adresser. Rapporten giver de tal, der kan indtastes eller
// uploades i kommunens og forbundenes portaler: aktive medlemmer pr. aldersgruppe på en valgt dato og spillere pr. hold.
// Medlemmer uden fødselsdato står for sig, så man kan rette dem, før tallet indberettes.
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
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

/** Aktive medlemmer på en dato: indmeldt senest den dag og ikke udmeldt før dagen efter. */
export async function memberStats(db: Db, ctx: AccessContext, clubId: string, asOf: string) {
  assertCan(ctx, { action: "finance.manage", clubId });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || Number.isNaN(Date.parse(asOf))) throw new Error("Vælg en dato.");
  const endOfDay = new Date(`${asOf}T23:59:59.999Z`);
  const iso = endOfDay.toISOString();
  const rows = await db
    .select({ profileId: profiles.id, birthDate: profiles.birthDate })
    .from(clubMemberships)
    .innerJoin(profiles, eq(profiles.id, clubMemberships.profileId))
    .where(
      and(
        eq(clubMemberships.clubId, clubId),
        eq(clubMemberships.status, "active"),
        lte(clubMemberships.joinedAt, endOfDay),
        or(isNull(clubMemberships.leftAt), gt(clubMemberships.leftAt, endOfDay)),
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
  const perTeam = await db
    .select({ teamId: teams.id, name: teams.name, season: teams.season, players: sql<number>`count(distinct ${teamMembers.profileId})::int` })
    .from(teams)
    .leftJoin(
      teamMembers,
      and(
        eq(teamMembers.teamId, teams.id),
        eq(teamMembers.role, "player"),
        sql`${teamMembers.profileId} in (select profile_id from club_memberships where club_id = ${clubId} and status = 'active' and created_at <= ${iso}::timestamptz and (left_at is null or left_at > ${iso}::timestamptz))`,
      ),
    )
    .where(eq(teams.clubId, clubId))
    .groupBy(teams.id, teams.name, teams.season)
    .orderBy(asc(teams.name));
  return { asOf, total: rows.length, bands, unknown, under25, under18, perTeam };
}

/** Tallene som regneark (semikolon, BOM for Excel). */
export async function memberStatsCsv(db: Db, ctx: AccessContext, clubId: string, asOf: string) {
  const s = await memberStats(db, ctx, clubId, asOf);
  await logAudit(db, { action: "memberstats.exported", clubId, actorUserId: ctx.userId, detail: { asOf } });
  const line = (...cells: unknown[]) => cells.map(csvCell).join(";");
  const lines = [
    line("Medlemstal pr.", s.asOf),
    line("Aldersgruppe", "Antal"),
    ...s.bands.map((b) => line(b.label, b.count)),
    line("Uden fødselsdato", s.unknown),
    line("I alt", s.total),
    line("Heraf under 18 år", s.under18),
    line("Heraf under 25 år", s.under25),
    "",
    line("Hold", "Sæson", "Spillere"),
    ...s.perTeam.map((t) => line(t.name, t.season ?? "", t.players)),
  ];
  return "﻿" + lines.join("\r\n") + "\r\n";
}
