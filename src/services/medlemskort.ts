// Digitalt medlemskort: et kort på telefonen med en QR-kode, som en træner, kassereren eller admin kan scanne.
//
// Regler:
//   - Man har et kort pr. forening, man er aktivt medlem af, for sig selv og for børn man er værge for.
//   - QR-koden indeholder kun et hemmeligt link (/tjek/<token>), ingen personoplysninger. Koden kan nulstilles,
//     og det gamle kort holder straks op med at virke.
//   - Scanningen kræver login som admin, kasserer eller træner i foreningen og viser navn, om medlemskabet er gyldigt,
//     og holdene. Kun admin og kasserer ser, om der er en forfalden opkrævning; trænere ser aldrig noget om betaling.
//   - Et kort er gyldigt, så længe medlemskabet er aktivt. Udmeldte og ventelistemedlemmer får "ikke gyldigt".
//     Foreningen kan vælge, at et kort også er ugyldigt ved en forfalden opkrævning (standard: gyldigt). Trænere ser kun "ikke gyldigt".
import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { charges, clubMemberships, clubs, memberCards, profiles, teamMembers, teams } from "../db/schema";
import { ForbiddenError, canActAs, type AccessContext } from "../auth/permissions";
import { localDate } from "../lib/money";

const newToken = () => randomBytes(24).toString("base64url");
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

/** Kortene for mig selv og mine børn, i de foreninger hvor de er aktive medlemmer. Kortet oprettes, første gang det vises. */
export async function listMyCards(db: Db, ctx: AccessContext) {
  const ids = [ctx.profileId, ...ctx.wards];
  const rows = await db
    .select({
      clubId: clubMemberships.clubId,
      clubName: clubs.name,
      profileId: profiles.id,
      firstName: profiles.firstName,
      lastName: profiles.lastName,
      joinedAt: clubMemberships.joinedAt,
    })
    .from(clubMemberships)
    .innerJoin(clubs, eq(clubs.id, clubMemberships.clubId))
    .innerJoin(profiles, eq(profiles.id, clubMemberships.profileId))
    .where(and(inArray(clubMemberships.profileId, ids), eq(clubMemberships.status, "active")))
    .orderBy(asc(clubs.name), asc(profiles.firstName));
  if (rows.length === 0) return [];
  await db
    .insert(memberCards)
    .values(rows.map((r) => ({ clubId: r.clubId, profileId: r.profileId, token: newToken() })))
    .onConflictDoNothing();
  const cards = await db.select().from(memberCards).where(inArray(memberCards.profileId, ids));
  const teamRows = await db
    .select({ profileId: teamMembers.profileId, clubId: teams.clubId, team: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(inArray(teamMembers.profileId, ids));
  return rows.map((r) => ({
    ...r,
    name: `${r.firstName} ${r.lastName}`,
    self: r.profileId === ctx.profileId,
    token: cards.find((c) => c.clubId === r.clubId && c.profileId === r.profileId)!.token,
    teams: teamRows.filter((t) => t.profileId === r.profileId && t.clubId === r.clubId).map((t) => t.team),
  }));
}

/** Nulstil kortets kode, fx ved mistet telefon. Det gamle kort virker ikke mere. */
export async function resetCard(db: Db, ctx: AccessContext, clubId: string, profileId: string) {
  if (!canActAs(ctx, profileId)) throw new ForbiddenError("profile.actAs");
  const done = await db.update(memberCards).set({ token: newToken() }).where(and(eq(memberCards.clubId, clubId), eq(memberCards.profileId, profileId))).returning({ id: memberCards.id });
  if (done.length === 0) throw new Error("Kortet findes ikke.");
}

export type CardCheck =
  | { found: false }
  | {
      found: true;
      valid: boolean;
      name: string;
      clubName: string;
      teams: string[];
      /** Kun for admin og kasserer: har medlemmet en forfalden, ubetalt opkrævning? Ellers null. */
      overdue: boolean | null;
    };

/** Scan et kort. Kun admin, kasserer og trænere i foreningen må; andre får ForbiddenError. */
export async function checkCard(db: Db, ctx: AccessContext, token: string): Promise<CardCheck> {
  if (!TOKEN.test(token)) return { found: false };
  const [card] = await db.select().from(memberCards).where(eq(memberCards.token, token));
  if (!card) return { found: false };
  const clubTeams = await db.select({ id: teams.id }).from(teams).where(eq(teams.clubId, card.clubId));
  const finance = ctx.adminClubs.has(card.clubId) || ctx.treasurerClubs.has(card.clubId);
  const coach = clubTeams.some((t) => ctx.coachTeams.has(t.id));
  if (!finance && !coach) throw new ForbiddenError("club.view");

  const [row] = await db
    .select({ status: clubMemberships.status, firstName: profiles.firstName, lastName: profiles.lastName, clubName: clubs.name, deletedAt: profiles.deletedAt })
    .from(clubMemberships)
    .innerJoin(profiles, eq(profiles.id, clubMemberships.profileId))
    .innerJoin(clubs, eq(clubs.id, clubMemberships.clubId))
    .where(and(eq(clubMemberships.clubId, card.clubId), eq(clubMemberships.profileId, card.profileId)));
  if (!row) return { found: false };
  const teamRows = await db
    .select({ team: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.profileId, card.profileId), eq(teams.clubId, card.clubId)))
    .orderBy(asc(teams.name));
  const [rule] = await db.select({ strict: clubs.cardInvalidWhenOverdue }).from(clubs).where(eq(clubs.id, card.clubId));
  let isOverdue = false;
  if (finance || rule?.strict) {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(charges)
      .where(and(eq(charges.clubId, card.clubId), eq(charges.profileId, card.profileId), eq(charges.status, "open"), lt(charges.dueDate, localDate(ctx.now)), sql`${charges.amountOre} > 0`));
    isOverdue = r.n > 0;
  }
  const overdue = finance ? isOverdue : null;
  return { found: true, valid: row.status === "active" && !row.deletedAt && !(rule?.strict && isOverdue), name: `${row.firstName} ${row.lastName}`, clubName: row.clubName, teams: teamRows.map((t) => t.team), overdue };
}
