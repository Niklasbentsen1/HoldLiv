// Foreningens offentlige hjemmeside: /klub/<slug>. Åben for alle uden login, så den viser kun det, der trygt kan stå på nettet.
//
// Regler:
//   - Siden er slået fra som standard. Foreningens admin tænder den og vælger selv, om hold og kalender vises.
//   - Siden viser foreningens navn, en introduktion og kontaktoplysninger, som foreningen selv skriver, hold (navn og sæson),
//     kommende aktiviteter (titel, tid, sted og hold) og link til online indmeldelse, hvis den er åben.
//   - Aldrig personer: ingen medlemmer, trænere, børn, svar, fremmøde, beskeder eller betalinger. Aktiviteternes titler og steder
//     og nyhederne vises, som de er skrevet, så foreningen må ikke skrive personnavne i dem.
//   - Nyheder vises kun, hvis ledelsen selv har markeret dem "vis på hjemmesiden". Holdnyheder og opslag vises aldrig.
//   - Hjemmesiden er kun læsning. Den giver ingen adgang til andet i HoldLiv.
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubs, events, posts, teams } from "../db/schema";
import { assertCan, type AccessContext } from "../auth/permissions";
import { localDate } from "../lib/money";
import { logAudit } from "./audit";
import { listOpenTicketEvents } from "./billetter";

export const MAX_SITE_INTRO = 2000;
export const MAX_SITE_CONTACT = 500;
export const SITE_DAYS_AHEAD = 30;
export const SITE_MAX_EVENTS = 40;
export const SITE_MAX_NEWS = 10;
const SLUG = /^[a-z0-9-]{1,80}$/;

export interface SiteSettings {
  enabled: boolean;
  intro?: string | null;
  contact?: string | null;
  showTeams: boolean;
  showCalendar: boolean;
}

export async function saveSiteSettings(db: Db, ctx: AccessContext, clubId: string, s: SiteSettings) {
  assertCan(ctx, { action: "club.manage", clubId });
  const intro = s.intro?.trim() || null;
  const contact = s.contact?.trim() || null;
  if (intro && intro.length > MAX_SITE_INTRO) throw new Error(`Introduktionen må højst være på ${MAX_SITE_INTRO} tegn.`);
  if (contact && contact.length > MAX_SITE_CONTACT) throw new Error(`Kontaktoplysningerne må højst være på ${MAX_SITE_CONTACT} tegn.`);
  await db.update(clubs).set({ siteEnabled: s.enabled, siteIntro: intro, siteContact: contact, siteShowTeams: s.showTeams, siteShowCalendar: s.showCalendar }).where(eq(clubs.id, clubId));
  await logAudit(db, { action: "site.settings", clubId, actorUserId: ctx.userId, detail: { enabled: s.enabled, showTeams: s.showTeams, showCalendar: s.showCalendar } });
}

/** Markerer en foreningsnyhed til (eller fra) hjemmesiden. Kun ledelsen, og kun nyheder for hele foreningen. */
export async function setPostPublic(db: Db, ctx: AccessContext, postId: string, isPublic: boolean) {
  const [p] = await db.select().from(posts).where(and(eq(posts.id, postId), isNull(posts.deletedAt)));
  if (!p) throw new Error("Nyheden findes ikke.");
  assertCan(ctx, { action: "club.manage", clubId: p.clubId });
  if (p.kind !== "news" || p.teamId) throw new Error("Kun foreningens egne nyheder kan vises på hjemmesiden.");
  await db.update(posts).set({ publicOnSite: isPublic }).where(eq(posts.id, postId));
  await logAudit(db, { action: "site.news_visibility", clubId: p.clubId, actorUserId: ctx.userId, targetType: "post", targetId: postId, detail: { public: isPublic } });
}

export interface PublicSite {
  clubName: string;
  slug: string;
  intro: string | null;
  contact: string | null;
  signupOpen: boolean;
  news: { id: string; title: string; body: string; createdAt: Date }[];
  /** Arrangementer med åbent billetsalg. */
  tickets: Awaited<ReturnType<typeof listOpenTicketEvents>>;
  teams: { id: string; name: string; season: string | null }[] | null;
  days: { date: string; events: { id: string; title: string; type: string; team: string; location: string | null; startsAt: Date; endsAt: Date | null; cancelled: boolean }[] }[] | null;
}

/** Det den åbne side viser. Kaldes uden login. Null, hvis foreningen ikke findes eller ikke har tændt hjemmesiden. */
export async function getPublicSite(db: Db, slug: string, now = new Date()): Promise<PublicSite | null> {
  if (!SLUG.test(slug)) return null;
  const [club] = await db.select().from(clubs).where(eq(clubs.slug, slug));
  if (!club || !club.siteEnabled) return null;

  const news = (
    await db
      .select({ id: posts.id, title: posts.title, body: posts.body, createdAt: posts.createdAt })
      .from(posts)
      .where(and(eq(posts.clubId, club.id), isNull(posts.teamId), eq(posts.kind, "news"), eq(posts.publicOnSite, true), isNull(posts.deletedAt), or(isNull(posts.expiresAt), gt(posts.expiresAt, now))))
      .orderBy(desc(posts.pinned), desc(posts.createdAt))
      .limit(SITE_MAX_NEWS)
  ).map((p) => ({ id: p.id, title: p.title, body: p.body, createdAt: p.createdAt }));

  const teamList = club.siteShowTeams
    ? await db.select({ id: teams.id, name: teams.name, season: teams.season }).from(teams).where(eq(teams.clubId, club.id)).orderBy(asc(teams.name))
    : null;

  let days: PublicSite["days"] = null;
  if (club.siteShowCalendar) {
    const until = new Date(now.getTime() + (SITE_DAYS_AHEAD + 1) * 86_400_000);
    const rows = await db
      .select({ e: events, teamName: teams.name })
      .from(events)
      .innerJoin(teams, eq(teams.id, events.teamId))
      .where(and(eq(events.clubId, club.id), sql`coalesce(${events.endsAt}, ${events.startsAt} + interval '2 hours') >= ${now.toISOString()}::timestamptz`, lt(events.startsAt, until)))
      .orderBy(asc(events.startsAt))
      .limit(SITE_MAX_EVENTS);
    const lastDay = localDate(new Date(now.getTime() + SITE_DAYS_AHEAD * 86_400_000));
    const byDay = new Map<string, NonNullable<PublicSite["days"]>[number]>();
    for (const r of rows) {
      const date = localDate(r.e.startsAt);
      if (date > lastDay) continue;
      const day = byDay.get(date) ?? { date, events: [] };
      day.events.push({ id: r.e.id, title: r.e.title, type: r.e.type, team: r.teamName, location: r.e.location, startsAt: r.e.startsAt, endsAt: r.e.endsAt, cancelled: !!r.e.cancelledAt });
      byDay.set(date, day);
    }
    days = [...byDay.values()];
  }

  return { clubName: club.name, slug: club.slug, intro: club.siteIntro, contact: club.siteContact, signupOpen: club.signupEnabled, news, tickets: await listOpenTicketEvents(db, club.id, now), teams: teamList, days };
}
