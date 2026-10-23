// Infoskærm: en skærm i klubhuset eller hallen, der viser dagens og ugens aktiviteter og de seneste nyheder.
//
// Regler:
//   - Admin opretter skærme under Forening. Hver skærm har et hemmeligt link (/skaerm/<token>), som kan nulstilles og slettes.
//   - Siden kræver ikke login, så den viser kun det, der trygt kan hænge på en væg: aktivitetens titel, tid, sted og hold,
//     samt foreningens egne nyheder. Aldrig personnavne, svar, fremmøde, beskeder eller betalinger. Holdnyheder vises ikke.
//   - Skærmen viser højst 14 dage frem og en fast besked, foreningen selv skriver. Højst 10 skærme pr. forening.
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubs, events, infoScreens, posts, teams } from "../db/schema";
import { assertCan, type AccessContext } from "../auth/permissions";
import { localDate } from "../lib/money";
import { logAudit } from "./audit";

export const MAX_SCREENS = 10;
export const MAX_DAYS_AHEAD = 14;
const newToken = () => randomBytes(24).toString("base64url");

export interface ScreenInput {
  name: string;
  message?: string | null;
  showNews?: boolean;
  daysAhead?: number;
}

function clean(input: ScreenInput) {
  const name = input.name.trim();
  if (!name) throw new Error("Giv skærmen et navn, fx Klubhuset.");
  if (name.length > 60) throw new Error("Navnet må højst være på 60 tegn.");
  const message = input.message?.trim() || null;
  if (message && message.length > 300) throw new Error("Beskeden må højst være på 300 tegn.");
  const daysAhead = input.daysAhead ?? 3;
  if (!Number.isInteger(daysAhead) || daysAhead < 1 || daysAhead > MAX_DAYS_AHEAD) throw new Error(`Skærmen kan vise fra 1 til ${MAX_DAYS_AHEAD} dage frem.`);
  return { name, message, showNews: input.showNews ?? true, daysAhead };
}

async function loadScreen(db: Db, screenId: string) {
  const [s] = await db.select().from(infoScreens).where(eq(infoScreens.id, screenId));
  if (!s) throw new Error("Skærmen findes ikke.");
  return s;
}

export async function createScreen(db: Db, ctx: AccessContext, clubId: string, input: ScreenInput) {
  assertCan(ctx, { action: "club.manage", clubId });
  const values = clean(input);
  return db.transaction(async (tx) => {
    // Lås foreningen, så to samtidige oprettelser ikke slipper forbi grænsen.
    await tx.select({ id: clubs.id }).from(clubs).where(eq(clubs.id, clubId)).for("update");
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(infoScreens).where(eq(infoScreens.clubId, clubId));
    if (n >= MAX_SCREENS) throw new Error(`En forening kan have højst ${MAX_SCREENS} skærme.`);
    const [s] = await tx.insert(infoScreens).values({ clubId, token: newToken(), ...values }).returning();
    await logAudit(tx, { action: "screen.created", clubId, actorUserId: ctx.userId, targetType: "info_screen", targetId: s.id });
    return s;
  });
}

export async function listScreens(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  return db.select().from(infoScreens).where(eq(infoScreens.clubId, clubId)).orderBy(asc(infoScreens.name));
}

export async function updateScreen(db: Db, ctx: AccessContext, screenId: string, input: ScreenInput) {
  const s = await loadScreen(db, screenId);
  assertCan(ctx, { action: "club.manage", clubId: s.clubId });
  await db.update(infoScreens).set(clean(input)).where(eq(infoScreens.id, screenId));
}

/** Gør det gamle link ubrugeligt og giver et nyt. */
export async function resetScreenToken(db: Db, ctx: AccessContext, screenId: string) {
  const s = await loadScreen(db, screenId);
  assertCan(ctx, { action: "club.manage", clubId: s.clubId });
  await db.update(infoScreens).set({ token: newToken() }).where(eq(infoScreens.id, screenId));
  await logAudit(db, { action: "screen.token_reset", clubId: s.clubId, actorUserId: ctx.userId, targetType: "info_screen", targetId: screenId });
}

export async function deleteScreen(db: Db, ctx: AccessContext, screenId: string) {
  const s = await loadScreen(db, screenId);
  assertCan(ctx, { action: "club.manage", clubId: s.clubId });
  await db.delete(infoScreens).where(eq(infoScreens.id, screenId));
  await logAudit(db, { action: "screen.deleted", clubId: s.clubId, actorUserId: ctx.userId, targetType: "info_screen", targetId: screenId });
}

const trim = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

/**
 * Det skærmen viser. Kaldes uden login, så den returnerer kun det, der må hænge på en væg.
 * Null, hvis linket ikke findes (eller er nulstillet).
 */
export async function getScreenView(db: Db, token: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [screen] = await db.select().from(infoScreens).where(eq(infoScreens.token, token));
  if (!screen) return null;
  const [club] = await db.select({ name: clubs.name }).from(clubs).where(eq(clubs.id, screen.clubId));
  const until = new Date(now.getTime() + (screen.daysAhead + 1) * 86_400_000);
  const rows = await db
    .select({ e: events, teamName: teams.name })
    .from(events)
    .innerJoin(teams, eq(teams.id, events.teamId))
    .where(
      and(
        eq(events.clubId, screen.clubId),
        // Aktiviteter, der ikke er slut: med sluttid efter nu, ellers to timer efter start.
        sql`coalesce(${events.endsAt}, ${events.startsAt} + interval '2 hours') >= ${now.toISOString()}::timestamptz`,
        lt(events.startsAt, until),
      ),
    )
    .orderBy(asc(events.startsAt))
    .limit(200);
  const lastDay = localDate(new Date(now.getTime() + screen.daysAhead * 86_400_000));
  const shown = rows.filter((r) => localDate(r.e.startsAt) <= lastDay);
  const days = new Map<string, { date: string; events: { id: string; title: string; type: string; team: string; location: string | null; startsAt: Date; endsAt: Date | null; cancelled: boolean }[] }>();
  for (const r of shown) {
    const date = localDate(r.e.startsAt);
    const day = days.get(date) ?? { date, events: [] };
    day.events.push({ id: r.e.id, title: r.e.title, type: r.e.type, team: r.teamName, location: r.e.location, startsAt: r.e.startsAt, endsAt: r.e.endsAt, cancelled: !!r.e.cancelledAt });
    days.set(date, day);
  }
  const news = screen.showNews
    ? (
        await db
          .select({ id: posts.id, title: posts.title, body: posts.body, createdAt: posts.createdAt })
          .from(posts)
          .where(and(eq(posts.clubId, screen.clubId), isNull(posts.teamId), eq(posts.kind, "news"), isNull(posts.deletedAt), gte(posts.createdAt, new Date(now.getTime() - 60 * 86_400_000))))
          .orderBy(desc(posts.pinned), desc(posts.createdAt))
          .limit(3)
      ).map((p) => ({ id: p.id, title: p.title, body: trim(p.body, 280), createdAt: p.createdAt }))
    : [];
  return { clubName: club.name, screenName: screen.name, message: screen.message, today: localDate(now), days: [...days.values()], news };
}
