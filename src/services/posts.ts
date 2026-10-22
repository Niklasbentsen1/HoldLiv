// Nyheder og opslagstavle pr. forening og pr. hold.
//   Nyhed:       skrives af ledelsen (foreningens admin, eller holdets trænere/admin for et hold) og giver besked.
//   Opslagstavle: alle, der hører til foreningen eller holdet, kan skrive. Opslag udløber, og giver ingen besked.
// Et opslag ses af dem, der hører til: foreningens medlemmer (og deres forældre), eller holdets spillere, forældre og
// trænere. Foreningens admin ser alt i foreningen. Slet og fastgør kan ledelsen; forfatteren kan slette sit eget.
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubMemberships, clubs, posts, profiles, teamMembers, teams } from "../db/schema";
import { type AccessContext } from "../auth/permissions";
import { notifyUsers, recipientsOfPlayers, type Deliver } from "./notifications";

export type PostKind = "news" | "board";
export const MAX_TITLE = 120;
export const MAX_BODY = 5000;
export const DEFAULT_BOARD_DAYS = 30;
export const MAX_BOARD_DAYS = 365;

export interface Scope {
  /** "club:<id>" eller "team:<id>" */
  key: string;
  clubId: string;
  teamId: string | null;
  label: string;
  /** Må skrive en nyhed (ledelsen). */
  lead: boolean;
}

/** Foreninger og hold, login'et hører til (selv eller via børn), og dem man leder. */
export async function myScopes(db: Db, ctx: AccessContext): Promise<Scope[]> {
  const ids = [ctx.profileId, ...ctx.wards];
  const [clubRows, teamRows, adminTeams] = await Promise.all([
    db
      .select({ id: clubs.id, name: clubs.name })
      .from(clubMemberships)
      .innerJoin(clubs, eq(clubs.id, clubMemberships.clubId))
      .where(and(inArray(clubMemberships.profileId, ids), eq(clubMemberships.status, "active"))),
    db
      .select({ id: teams.id, name: teams.name, clubId: teams.clubId, clubName: clubs.name })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .innerJoin(clubs, eq(clubs.id, teams.clubId))
      .where(inArray(teamMembers.profileId, ids)),
    ctx.adminClubs.size
      ? db
          .select({ id: teams.id, name: teams.name, clubId: teams.clubId, clubName: clubs.name })
          .from(teams)
          .innerJoin(clubs, eq(clubs.id, teams.clubId))
          .where(inArray(teams.clubId, [...ctx.adminClubs]))
      : [],
  ]);
  const adminClubRows = ctx.adminClubs.size ? await db.select({ id: clubs.id, name: clubs.name }).from(clubs).where(inArray(clubs.id, [...ctx.adminClubs])) : [];

  const out = new Map<string, Scope>();
  for (const c of [...clubRows, ...adminClubRows]) out.set(`club:${c.id}`, { key: `club:${c.id}`, clubId: c.id, teamId: null, label: c.name, lead: ctx.adminClubs.has(c.id) });
  for (const t of [...teamRows, ...adminTeams]) {
    out.set(`team:${t.id}`, { key: `team:${t.id}`, clubId: t.clubId, teamId: t.id, label: `${t.name} (${t.clubName})`, lead: ctx.adminClubs.has(t.clubId) || ctx.coachTeams.has(t.id) });
  }
  return [...out.values()].sort((a, b) => Number(!!a.teamId) - Number(!!b.teamId) || a.label.localeCompare(b.label, "da"));
}

/** Hvor man må skrive: nyheder kun som leder, opslag overalt hvor man hører til. */
export async function listPostTargets(db: Db, ctx: AccessContext, kind: PostKind) {
  const scopes = await myScopes(db, ctx);
  return kind === "news" ? scopes.filter((s) => s.lead) : scopes;
}

export interface NewPost {
  kind: PostKind;
  scope: string;
  title: string;
  body: string;
  pinned?: boolean;
  /** Kun opslag: antal dage før det forsvinder. */
  expiresInDays?: number | null;
}

async function recipientsOfScope(db: Db, scope: Scope, now: Date) {
  const profileIds = scope.teamId
    ? await db.select({ id: teamMembers.profileId }).from(teamMembers).where(eq(teamMembers.teamId, scope.teamId))
    : await db.select({ id: clubMemberships.profileId }).from(clubMemberships).where(and(eq(clubMemberships.clubId, scope.clubId), eq(clubMemberships.status, "active")));
  return recipientsOfPlayers(db, [...new Set(profileIds.map((p) => p.id))], now);
}

export async function createPost(db: Db, ctx: AccessContext, deliver: Deliver, input: NewPost) {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) throw new Error("Skriv en overskrift.");
  if (title.length > MAX_TITLE) throw new Error(`Overskriften er for lang (højst ${MAX_TITLE} tegn).`);
  if (!body) throw new Error("Skriv en tekst.");
  if (body.length > MAX_BODY) throw new Error(`Teksten er for lang (højst ${MAX_BODY} tegn).`);
  const scope = (await myScopes(db, ctx)).find((s) => s.key === input.scope);
  if (!scope) throw new Error("Du hører ikke til der.");
  if (input.kind === "news" && !scope.lead) throw new Error("Kun ledelsen kan skrive nyheder.");
  if (input.pinned && !scope.lead) throw new Error("Kun ledelsen kan fastgøre opslag.");

  let expiresAt: Date | null = null;
  if (input.kind === "board") {
    const days = input.expiresInDays ?? DEFAULT_BOARD_DAYS;
    if (!Number.isInteger(days) || days < 1 || days > MAX_BOARD_DAYS) throw new Error(`Et opslag kan vare fra 1 til ${MAX_BOARD_DAYS} dage.`);
    expiresAt = new Date(ctx.now.getTime() + days * 86_400_000);
  }
  const [post] = await db
    .insert(posts)
    .values({ clubId: scope.clubId, teamId: scope.teamId, kind: input.kind, title, body, pinned: !!input.pinned, authorUserId: ctx.userId, authorProfileId: ctx.profileId, expiresAt })
    .returning();

  if (input.kind === "news") {
    try {
      const recipients = (await recipientsOfScope(db, scope, ctx.now)).filter((r) => r.userId !== ctx.userId);
      await notifyUsers(db, deliver, recipients, {
        kind: "news",
        subject: `Nyhed: ${title}`,
        body: `${scope.label}: ${title}\n\n${body}\n\nSe alle nyheder: ${deliver.baseUrl}/nyheder`,
        sms: `HoldLiv ${scope.label}: ${title}`,
        url: "/nyheder",
        dedupeKey: `post:${post.id}`,
      });
    } catch (e) {
      console.error("[posts] kunne ikke sende besked om nyhed", e);
    }
  }
  return post;
}

export interface FeedPost {
  id: string;
  kind: PostKind;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: Date;
  expiresAt: Date | null;
  scopeLabel: string;
  authorName: string;
  mine: boolean;
  canManage: boolean;
}

/** Nyheder eller opslag, man må se, med fastgjorte først og derefter de nyeste. Udløbne opslag vises ikke. */
export async function listFeed(db: Db, ctx: AccessContext, kind: PostKind, limit = 50): Promise<FeedPost[]> {
  const scopes = await myScopes(db, ctx);
  const clubIds = scopes.filter((s) => !s.teamId).map((s) => s.clubId);
  const teamIds = scopes.filter((s) => s.teamId).map((s) => s.teamId!);
  if (clubIds.length === 0 && teamIds.length === 0) return [];
  const visible = or(
    clubIds.length ? and(isNull(posts.teamId), inArray(posts.clubId, clubIds)) : undefined,
    teamIds.length ? inArray(posts.teamId, teamIds) : undefined,
  );
  const rows = await db
    .select({ p: posts, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(posts)
    .innerJoin(profiles, eq(profiles.id, posts.authorProfileId))
    .where(and(eq(posts.kind, kind), isNull(posts.deletedAt), or(isNull(posts.expiresAt), gt(posts.expiresAt, ctx.now)), visible))
    .orderBy(desc(posts.pinned), desc(posts.createdAt))
    .limit(limit);
  const byKey = new Map(scopes.map((s) => [s.key, s]));
  return rows.map(({ p, firstName, lastName }) => {
    const scope = byKey.get(p.teamId ? `team:${p.teamId}` : `club:${p.clubId}`);
    return {
      id: p.id,
      kind: p.kind,
      title: p.title,
      body: p.body,
      pinned: p.pinned,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      scopeLabel: scope?.label ?? "",
      authorName: `${firstName} ${lastName}`,
      mine: p.authorUserId === ctx.userId,
      canManage: !!scope?.lead,
    };
  });
}

async function loadManageable(db: Db, ctx: AccessContext, postId: string) {
  const [p] = await db.select().from(posts).where(and(eq(posts.id, postId), isNull(posts.deletedAt)));
  if (!p) throw new Error("Opslaget findes ikke.");
  const scope = (await myScopes(db, ctx)).find((s) => s.key === (p.teamId ? `team:${p.teamId}` : `club:${p.clubId}`));
  // Samme svar for "findes ikke" og "ingen adgang".
  if (!scope) throw new Error("Opslaget findes ikke.");
  return { post: p, lead: scope.lead };
}

export async function setPostPinned(db: Db, ctx: AccessContext, postId: string, pinned: boolean) {
  const { lead } = await loadManageable(db, ctx, postId);
  if (!lead) throw new Error("Kun ledelsen kan fastgøre opslag.");
  await db.update(posts).set({ pinned }).where(eq(posts.id, postId));
}

export async function deletePost(db: Db, ctx: AccessContext, postId: string) {
  const { post, lead } = await loadManageable(db, ctx, postId);
  if (!lead && post.authorUserId !== ctx.userId) throw new Error("Det må du ikke.");
  await db.update(posts).set({ deletedAt: ctx.now }).where(eq(posts.id, postId));
}

