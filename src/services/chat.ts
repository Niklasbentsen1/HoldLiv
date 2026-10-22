// Holdchat. Grupperne er automatiske: hvem der er med regnes ud fra holdet hver gang, så ingen skal tilføjes.
//   all              trænere, spillere med eget login og forældre til spillere under 18
//   coaches          kun holdets trænere
//   coaches_parents  trænere og forældre til spillere under 18 (ikke de voksne spillere)
//   event            som "all", men knyttet til én aktivitet
// Børn har intet login og er derfor aldrig med i en chat. Foreningens admin er ikke med automatisk, fordi
// chatten ellers kunne læses uden at nogen ved det.
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { chatMessages, chatReads, chatThreads, events, guardianships, profiles, teamMembers, teams } from "../db/schema";
import { isMinor, type AccessContext } from "../auth/permissions";
import { requireModule } from "./modules";
import { notifyUsers, recipientsOfPlayers, type Deliver, type Recipient } from "./notifications";

export type ChatKind = "all" | "coaches" | "coaches_parents" | "event";
export const MAX_MESSAGE_LENGTH = 2000;
export const KIND_LABEL: Record<Exclude<ChatKind, "event">, { name: string; about: string }> = {
  all: { name: "Hele holdet", about: "Trænere, spillere og forældre" },
  coaches_parents: { name: "Trænere og forældre", about: "Til forældre og trænere, uden de voksne spillere" },
  coaches: { name: "Trænere", about: "Kun holdets trænere" },
};
const GROUP_ORDER = ["all", "coaches_parents", "coaches"] as const;

interface Roles {
  coach: boolean;
  player: boolean;
  parent: boolean;
}

async function playersOf(db: Db, teamId: string) {
  return db
    .select({ id: profiles.id, firstName: profiles.firstName, birthDate: profiles.birthDate })
    .from(teamMembers)
    .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "player")));
}

async function rolesOn(db: Db, ctx: AccessContext, teamId: string): Promise<Roles> {
  const players = await playersOf(db, teamId);
  const ids = new Set(players.map((p) => p.id));
  return {
    coach: ctx.coachTeams.has(teamId),
    player: ids.has(ctx.profileId) && !isMinor(players.find((p) => p.id === ctx.profileId)!.birthDate, ctx.now),
    parent: [...ctx.wards].some((w) => ids.has(w)),
  };
}

function canSee(kind: ChatKind, r: Roles) {
  if (kind === "coaches") return r.coach;
  if (kind === "coaches_parents") return r.coach || r.parent;
  return r.coach || r.player || r.parent;
}

/** Logins i en chat, som modtagere til beskeder. */
async function membersOf(db: Db, teamId: string, kind: ChatKind, now: Date): Promise<Recipient[]> {
  const [coaches, players] = await Promise.all([
    db
      .select({ profileId: teamMembers.profileId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "coach"))),
    playersOf(db, teamId),
  ]);
  let list: Recipient[] = [];
  if (kind === "all" || kind === "event") {
    list = await recipientsOfPlayers(db, players.map((p) => p.id), now);
  } else if (kind === "coaches_parents") {
    const minors = players.filter((p) => isMinor(p.birthDate, now)).map((p) => p.id);
    const guardians = minors.length
      ? await db.select({ id: guardianships.guardianProfileId }).from(guardianships).where(inArray(guardianships.childProfileId, minors))
      : [];
    // Forældrene er selv voksne profiler, så deres eget login er modtageren.
    list = await recipientsOfPlayers(db, [...new Set(guardians.map((g) => g.id))], now);
  }
  const coachRecipients = await recipientsOfPlayers(db, coaches.map((c) => c.profileId), now);
  const byUser = new Map([...list, ...coachRecipients].map((r) => [r.userId, r]));
  return [...byUser.values()];
}

async function ensureGroupThreads(db: Db, teamId: string) {
  await db
    .insert(chatThreads)
    .values(GROUP_ORDER.map((kind) => ({ teamId, kind })))
    .onConflictDoNothing();
}

export interface ChatSummary {
  id: string;
  kind: ChatKind;
  name: string;
  about: string;
  unread: number;
  lastAt: Date | null;
  lastText: string | null;
}

/** De samtaler, man må se på holdet, med antal ulæste. */
export async function listChats(db: Db, ctx: AccessContext, teamId: string): Promise<ChatSummary[]> {
  await requireModule(db, ctx, teamId, "chat");
  const roles = await rolesOn(db, ctx, teamId);
  if (!canSee("all", roles)) return [];
  await ensureGroupThreads(db, teamId);
  const threads = await db.select().from(chatThreads).where(and(eq(chatThreads.teamId, teamId), ne(chatThreads.kind, "event")));
  const visible = threads.filter((t) => canSee(t.kind, roles));
  const out: ChatSummary[] = [];
  for (const t of visible) {
    const [unread, [last]] = await Promise.all([unreadIn(db, t.id, ctx.userId), lastMessage(db, t.id)]);
    out.push({
      id: t.id,
      kind: t.kind,
      name: KIND_LABEL[t.kind as keyof typeof KIND_LABEL].name,
      about: KIND_LABEL[t.kind as keyof typeof KIND_LABEL].about,
      unread,
      lastAt: last?.createdAt ?? null,
      lastText: last?.body ?? null,
    });
  }
  return out.sort((a, b) => GROUP_ORDER.indexOf(a.kind as (typeof GROUP_ORDER)[number]) - GROUP_ORDER.indexOf(b.kind as (typeof GROUP_ORDER)[number]));
}

async function lastMessage(db: Db, threadId: string) {
  return db
    .select({ body: chatMessages.body, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(and(eq(chatMessages.threadId, threadId), isNull(chatMessages.deletedAt)))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);
}

async function unreadIn(db: Db, threadId: string, userId: string) {
  const [read] = await db.select({ at: chatReads.readAt }).from(chatReads).where(and(eq(chatReads.threadId, threadId), eq(chatReads.userId, userId)));
  const [row] = await db
    .select({ n: count() })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        isNull(chatMessages.deletedAt),
        ne(chatMessages.authorUserId, userId),
        read ? gt(chatMessages.createdAt, read.at) : undefined,
      ),
    );
  return row.n;
}

/** Ulæste beskeder på tværs af holdets samtaler, til et mærke i menuen. */
export async function countUnread(db: Db, ctx: AccessContext, teamId: string) {
  const chats = await listChats(db, ctx, teamId).catch(() => []);
  return chats.reduce((n, c) => n + c.unread, 0);
}

async function loadThread(db: Db, ctx: AccessContext, threadId: string) {
  const [t] = await db.select().from(chatThreads).where(eq(chatThreads.id, threadId));
  // Samme svar for "findes ikke" og "ingen adgang", så man ikke kan gætte sig til samtaler.
  if (!t) throw new Error("Samtalen findes ikke.");
  await requireModule(db, ctx, t.teamId, "chat");
  const roles = await rolesOn(db, ctx, t.teamId);
  if (!canSee(t.kind, roles)) throw new Error("Samtalen findes ikke.");
  return { thread: t, roles };
}

/** Aktivitetens egen chat. Oprettes første gang, nogen åbner den. */
export async function getEventChat(db: Db, ctx: AccessContext, eventId: string) {
  const [e] = await db.select({ teamId: events.teamId }).from(events).where(eq(events.id, eventId));
  if (!e) throw new Error("Aktiviteten findes ikke.");
  await requireModule(db, ctx, e.teamId, "chat");
  if (!canSee("event", await rolesOn(db, ctx, e.teamId))) throw new Error("Samtalen findes ikke.");
  await db.insert(chatThreads).values({ teamId: e.teamId, kind: "event", eventId }).onConflictDoNothing();
  const [t] = await db.select({ id: chatThreads.id }).from(chatThreads).where(eq(chatThreads.eventId, eventId));
  return t.id;
}

/** Om aktiviteten har en chat, man må se (uden at oprette den). Til et link på aktivitetssiden. */
export async function eventChatVisible(db: Db, ctx: AccessContext, eventId: string) {
  try {
    const [e] = await db.select({ teamId: events.teamId }).from(events).where(eq(events.id, eventId));
    if (!e) return false;
    await requireModule(db, ctx, e.teamId, "chat");
    return canSee("event", await rolesOn(db, ctx, e.teamId));
  } catch {
    return false;
  }
}

/** "Træner", "Spiller" eller "Forælder til Emma", så man kan se, hvem man skriver med. */
async function describeAuthors(db: Db, teamId: string, profileIds: string[]) {
  const labels = new Map<string, string>();
  if (profileIds.length === 0) return labels;
  const [coaches, players, kids] = await Promise.all([
    db.select({ id: teamMembers.profileId }).from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "coach"), inArray(teamMembers.profileId, profileIds))),
    playersOf(db, teamId),
    db
      .select({ guardian: guardianships.guardianProfileId, firstName: profiles.firstName, childId: profiles.id })
      .from(guardianships)
      .innerJoin(profiles, eq(profiles.id, guardianships.childProfileId))
      .where(inArray(guardianships.guardianProfileId, profileIds)),
  ]);
  const playerIds = new Set(players.map((p) => p.id));
  for (const id of profileIds) {
    const children = kids.filter((k) => k.guardian === id && playerIds.has(k.childId)).map((k) => k.firstName);
    if (coaches.some((c) => c.id === id)) labels.set(id, "Træner");
    else if (children.length) labels.set(id, `Forælder til ${children.join(" og ")}`);
    else if (playerIds.has(id)) labels.set(id, "Spiller");
  }
  return labels;
}

export interface ChatMessage {
  id: string;
  authorName: string;
  authorLabel: string | null;
  body: string | null;
  createdAt: Date;
  mine: boolean;
  deleted: boolean;
  canDelete: boolean;
}

/** Samtalens seneste beskeder (ældst først). Åbning markerer samtalen som læst. */
export async function getChat(db: Db, ctx: AccessContext, threadId: string, limit = 100) {
  const { thread, roles } = await loadThread(db, ctx, threadId);
  const rows = await db
    .select({
      id: chatMessages.id,
      body: chatMessages.body,
      createdAt: chatMessages.createdAt,
      deletedAt: chatMessages.deletedAt,
      authorUserId: chatMessages.authorUserId,
      authorProfileId: chatMessages.authorProfileId,
      firstName: profiles.firstName,
      lastName: profiles.lastName,
    })
    .from(chatMessages)
    .innerJoin(profiles, eq(profiles.id, chatMessages.authorProfileId))
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit);
  rows.reverse();
  const labels = await describeAuthors(db, thread.teamId, [...new Set(rows.map((r) => r.authorProfileId))]);
  await db
    .insert(chatReads)
    .values({ threadId, userId: ctx.userId, readAt: new Date() })
    .onConflictDoUpdate({ target: [chatReads.threadId, chatReads.userId], set: { readAt: new Date() } });
  const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, thread.teamId));
  let eventTitle: string | null = null;
  if (thread.eventId) [{ title: eventTitle }] = await db.select({ title: events.title }).from(events).where(eq(events.id, thread.eventId));
  const messages: ChatMessage[] = rows.map((r) => ({
    id: r.id,
    authorName: `${r.firstName} ${r.lastName}`,
    authorLabel: labels.get(r.authorProfileId) ?? null,
    body: r.deletedAt ? null : r.body,
    createdAt: r.createdAt,
    mine: r.authorUserId === ctx.userId,
    deleted: !!r.deletedAt,
    canDelete: !r.deletedAt && (r.authorUserId === ctx.userId || roles.coach),
  }));
  const name = thread.kind === "event" ? (eventTitle ?? "Aktivitet") : KIND_LABEL[thread.kind as keyof typeof KIND_LABEL].name;
  return { id: thread.id, teamId: thread.teamId, teamName: team.name, kind: thread.kind, eventId: thread.eventId, name, messages };
}

/** Skriv i en samtale og giv de andre medlemmer besked (højst én gang pr. samtale hvert tiende minut). */
export async function postMessage(db: Db, ctx: AccessContext, deliver: Deliver, threadId: string, rawBody: string) {
  const body = rawBody.trim();
  if (!body) throw new Error("Skriv en besked først.");
  if (body.length > MAX_MESSAGE_LENGTH) throw new Error(`Beskeden er for lang (højst ${MAX_MESSAGE_LENGTH} tegn).`);
  const { thread } = await loadThread(db, ctx, threadId);
  const [msg] = await db
    .insert(chatMessages)
    .values({ threadId, authorUserId: ctx.userId, authorProfileId: ctx.profileId, body })
    .returning();
  await db
    .insert(chatReads)
    .values({ threadId, userId: ctx.userId })
    .onConflictDoUpdate({ target: [chatReads.threadId, chatReads.userId], set: { readAt: new Date() } });
  try {
    const members = (await membersOf(db, thread.teamId, thread.kind, ctx.now)).filter((m) => m.userId !== ctx.userId);
    const [[team], [me]] = await Promise.all([
      db.select({ name: teams.name }).from(teams).where(eq(teams.id, thread.teamId)),
      db.select({ firstName: profiles.firstName }).from(profiles).where(eq(profiles.id, ctx.profileId)),
    ]);
    const where = thread.kind === "event" ? `${team.name}, aktivitet` : `${team.name}, ${KIND_LABEL[thread.kind as keyof typeof KIND_LABEL].name}`;
    const short = body.length > 90 ? `${body.slice(0, 87)}...` : body;
    await notifyUsers(db, deliver, members, {
      kind: "chat",
      subject: `Ny besked i ${where}`,
      body: `${me.firstName} skrev i ${where}:\n\n${body}\n\nSvar her: ${deliver.baseUrl}/hold/${thread.teamId}/chat?samtale=${thread.id}`,
      sms: `${me.firstName} i ${where}: ${short}`,
      url: `/hold/${thread.teamId}/chat?samtale=${thread.id}`,
      dedupeKey: `chat:${thread.id}:${Math.floor(ctx.now.getTime() / 600_000)}`,
    });
  } catch (e) {
    console.error("[chat] kunne ikke sende besked om ny chatbesked", e);
  }
  return msg;
}

/** Forfatteren kan slette sin egen besked, og holdets trænere kan slette alle. */
export async function deleteMessage(db: Db, ctx: AccessContext, messageId: string) {
  const [m] = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId));
  if (!m) throw new Error("Beskeden findes ikke.");
  const { roles } = await loadThread(db, ctx, m.threadId);
  if (m.authorUserId !== ctx.userId && !roles.coach) throw new Error("Det må du ikke.");
  await db
    .update(chatMessages)
    .set({ deletedAt: ctx.now, deletedByUserId: ctx.userId })
    .where(and(eq(chatMessages.id, messageId), isNull(chatMessages.deletedAt)));
  return m.threadId;
}
