// Beskeder til forældre og spillere: mail og SMS og push i browseren. Hvert login vælger selv kanaler pr. slags besked.
//
// Regler:
//   - En besked går til de logins, der hører til holdets spillere: spillerens eget login og forældre til børn under 18 år.
//     Den, der selv lavede ændringen, får ikke besked om den.
//   - Mail er slået til som standard, SMS er opt-in og kræver et telefonnummer. En kanal, der ikke er sat op eller
//     mangler modtager, springes over, og det noteres i `notifications`.
//   - En fejl hos mail- eller SMS-udbyderen får aldrig selve ændringen (fx en aflysning) til at fejle; den noteres.
//   - dedupe_key sørger for, at den samme besked ikke sendes to gange til samme login på samme kanal.
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { deviceTokens, eventResponses, events, guardianships, notificationPrefs, notifications, profiles, pushSubscriptions, sessions, teamMembers, teams, users } from "../db/schema";
import { isMinor, type AccessContext } from "../auth/permissions";
import { CHANNELS, KINDS, defaultEnabled, isMandatory, type Channel, type Kind } from "../lib/notify";
import { normalizePhone, type SmsSender } from "../lib/sms";
import type { Mailer } from "../lib/mail";
import { PushGoneError, type PushSender } from "../lib/push";
import { DeviceGoneError, type DevicePushSender } from "../lib/devicePush";
import { TYPE_LABEL, shortDay, time, when } from "../lib/format";
import { confirmedProfileIds, setEventCancelled, updateEvent } from "./calendar";
import { respondToEvent } from "./index";
import type { EventInput } from "./index";

export interface Deliver {
  mail: Mailer;
  /** Null, når der ikke er nogen SMS-udbyder. */
  sms: SmsSender | null;
  /** Udeladt eller null, når push ikke er sat op. */
  push?: PushSender | null;
  /** Mobilappen. Udeladt eller null, når den ikke er sat op. */
  devicePush?: DevicePushSender | null;
  baseUrl: string;
}

// --- Valg af kanaler ---

export async function getNotificationPrefs(db: Db, userId: string) {
  const rows = await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId));
  const [profile] = await db.select({ phone: profiles.phone }).from(profiles).where(eq(profiles.userId, userId));
  const matrix = {} as Record<Kind, Record<Channel, boolean>>;
  for (const kind of Object.keys(KINDS) as Kind[]) {
    matrix[kind] = {} as Record<Channel, boolean>;
    for (const channel of CHANNELS) {
      matrix[kind][channel] = rows.find((r) => r.kind === kind && r.channel === channel)?.enabled ?? defaultEnabled(kind, channel);
    }
  }
  return { prefs: matrix, phone: profile?.phone ?? null, hasValidPhone: !!(profile?.phone && normalizePhone(profile.phone)) };
}

/** Login'et vælger selv. SMS kræver et gyldigt dansk mobilnummer på egen profil. */
export async function setNotificationPref(db: Db, ctx: AccessContext, kind: string, channel: string, enabled: boolean) {
  if (!(kind in KINDS)) throw new Error("Ukendt slags besked.");
  if (!(CHANNELS as readonly string[]).includes(channel)) throw new Error("Ukendt kanal.");
  if (channel === "sms" && enabled) {
    const [me] = await db.select({ phone: profiles.phone }).from(profiles).where(eq(profiles.id, ctx.profileId));
    if (!me?.phone || !normalizePhone(me.phone)) throw new Error("Skriv dit danske mobilnummer først, så vi kan sende SMS.");
  }
  await db
    .insert(notificationPrefs)
    .values({ userId: ctx.userId, kind, channel, enabled })
    .onConflictDoUpdate({ target: [notificationPrefs.userId, notificationPrefs.kind, notificationPrefs.channel], set: { enabled } });
}

// --- Modtagere ---

export interface Recipient {
  userId: string;
  email: string;
  phone: string | null;
}

/** Logins, der skal høre om noget, der angår disse spillere: spilleren selv og forældre til børn under 18 år. */
export async function recipientsOfPlayers(db: Db, profileIds: string[], now = new Date()): Promise<Recipient[]> {
  if (profileIds.length === 0) return [];
  const [own, kids] = await Promise.all([
    db.select({ userId: profiles.userId }).from(profiles).where(inArray(profiles.id, profileIds)),
    db
      .select({ guardianProfileId: guardianships.guardianProfileId, birthDate: profiles.birthDate })
      .from(guardianships)
      .innerJoin(profiles, eq(profiles.id, guardianships.childProfileId))
      .where(inArray(guardianships.childProfileId, profileIds)),
  ]);
  const guardianIds = [...new Set(kids.filter((k) => isMinor(k.birthDate, now)).map((k) => k.guardianProfileId))];
  const guardianUsers = guardianIds.length
    ? await db.select({ userId: profiles.userId }).from(profiles).where(inArray(profiles.id, guardianIds))
    : [];
  const userIds = [...new Set([...own, ...guardianUsers].flatMap((r) => (r.userId ? [r.userId] : [])))];
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ userId: users.id, email: users.email, phone: profiles.phone })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(inArray(users.id, userIds));
  return rows;
}

// --- Afsendelse ---

export interface Message {
  kind: Kind;
  subject: string;
  /** Mailens tekst. Fodnoten med link til indstillinger lægges på af notifyUsers. */
  body: string;
  /** Kort tekst til SMS og push. */
  sms: string;
  /** Hvor et tryk på push-beskeden fører hen (en sti på HoldLiv). */
  url?: string;
  eventId?: string | null;
  /** Gør beskeden til én gang pr. login og kanal. */
  dedupeKey?: string | null;
}

/** Sender en besked til hvert login på de kanaler, det har slået til. Kaster aldrig på grund af udbydere. */
export async function notifyUsers(db: Db, deliver: Deliver, recipients: Recipient[], msg: Message) {
  const result = { sent: 0, skipped: 0, failed: 0 };
  const prefsRows = recipients.length
    ? await db.select().from(notificationPrefs).where(and(inArray(notificationPrefs.userId, recipients.map((r) => r.userId)), eq(notificationPrefs.kind, msg.kind)))
    : [];
  const subs = recipients.length
    ? await db
        .select({ id: pushSubscriptions.id, userId: pushSubscriptions.userId, endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
        .from(pushSubscriptions)
        .innerJoin(sessions, eq(sessions.id, pushSubscriptions.sessionId))
        .where(and(inArray(pushSubscriptions.userId, recipients.map((r) => r.userId)), gt(sessions.expiresAt, new Date())))
    : [];
  const devices = recipients.length
    ? await db
        .select({ id: deviceTokens.id, userId: deviceTokens.userId, token: deviceTokens.token })
        .from(deviceTokens)
        .innerJoin(sessions, eq(sessions.id, deviceTokens.sessionId))
        .where(and(inArray(deviceTokens.userId, recipients.map((r) => r.userId)), gt(sessions.expiresAt, new Date())))
    : [];
  const footer = `\n\nVil du have beskeder på en anden måde? Ret det her: ${deliver.baseUrl}/indstillinger`;

  for (const r of recipients) {
    for (const channel of CHANNELS) {
      const enabled = isMandatory(msg.kind, channel) || (prefsRows.find((p) => p.userId === r.userId && p.channel === channel)?.enabled ?? defaultEnabled(msg.kind, channel));
      if (!enabled) continue;
      const userSubs = channel === "push" ? subs.filter((x) => x.userId === r.userId) : [];
      const userDevices = channel === "push" ? devices.filter((x) => x.userId === r.userId) : [];
      if (channel === "push" && userSubs.length === 0 && userDevices.length === 0) continue; // ingen browsere eller telefoner at sende til, så ingen post
      const body = channel === "mail" ? msg.body + footer : msg.sms;

      const [row] = await db
        .insert(notifications)
        .values({ userId: r.userId, kind: msg.kind, channel, subject: msg.subject, body, eventId: msg.eventId ?? null, dedupeKey: msg.dedupeKey ?? null, status: "pending" })
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      if (!row) continue; // allerede sendt

      let status: "sent" | "failed" | "skipped" = "sent";
      let error: string | null = null;
      try {
        if (channel === "mail") {
          await deliver.mail(r.email, msg.subject, body);
        } else if (channel === "push") {
          if (!deliver.push && !deliver.devicePush) {
            status = "skipped";
            error = "Push er ikke sat op";
          } else {
            const payload = JSON.stringify({ title: msg.subject, body: msg.sms, url: msg.url ?? "/" });
            let delivered = 0;
            let lastError: unknown = null;
            const { push, devicePush } = deliver;
            for (const d of devicePush ? userDevices : []) {
              try {
                await devicePush!(d.token, { title: msg.subject, body: msg.sms, url: msg.url ?? "/" });
                delivered++;
              } catch (e) {
                lastError = e;
                if (e instanceof DeviceGoneError) await db.delete(deviceTokens).where(eq(deviceTokens.id, d.id));
              }
            }
            for (const sub of push ? userSubs : []) {
              try {
                await push!({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload);
                delivered++;
              } catch (e) {
                lastError = e;
                if (e instanceof PushGoneError) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
              }
            }
            if (delivered === 0) throw lastError ?? new Error("Push fejlede");
          }
        } else {
          const phone = r.phone ? normalizePhone(r.phone) : null;
          if (!deliver.sms) {
            status = "skipped";
            error = "Ingen SMS-udbyder er sat op";
          } else if (!phone) {
            status = "skipped";
            error = "Intet gyldigt mobilnummer";
          } else {
            await deliver.sms(phone, body);
          }
        }
      } catch (e) {
        status = "failed";
        error = e instanceof Error ? e.message : String(e);
        console.error(`[notify] ${channel} til ${r.userId} fejlede: ${error}`);
      }
      await db.update(notifications).set({ status, error }).where(eq(notifications.id, row.id));
      result[status === "sent" ? "sent" : status === "failed" ? "failed" : "skipped"]++;
    }
  }
  return result;
}

// --- Ændringer og aflysninger af aktiviteter ---

type EventRow = typeof events.$inferSelect;

async function teamRecipients(db: Db, teamId: string, now: Date, exceptUserId: string) {
  const players = await db
    .select({ id: teamMembers.profileId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "player")));
  const all = await recipientsOfPlayers(db, players.map((p) => p.id), now);
  return all.filter((r) => r.userId !== exceptUserId);
}

const label = (e: Pick<EventRow, "type" | "title">) =>
  e.title.toLowerCase().startsWith(TYPE_LABEL[e.type].toLowerCase()) ? e.title : `${TYPE_LABEL[e.type]}: ${e.title}`;

/** Fortæl holdets familier, at en aktivitet er ændret. Aktiviteter der allerede er begyndt, giver ingen besked. */
async function announceChange(db: Db, deliver: Deliver, ctx: AccessContext, before: EventRow, after: EventRow) {
  if (after.startsAt.getTime() <= ctx.now.getTime() && before.startsAt.getTime() <= ctx.now.getTime()) return;
  const lines: string[] = [];
  const sms: string[] = [];
  if (before.startsAt.getTime() !== after.startsAt.getTime()) {
    lines.push(`Tid: ${when(before.startsAt)} -> ${when(after.startsAt)}`);
    sms.push(`nyt tidspunkt ${shortDay(after.startsAt)} kl. ${time(after.startsAt)}`);
  }
  if ((before.location ?? "") !== (after.location ?? "")) {
    lines.push(`Sted: ${before.location || "ikke angivet"} -> ${after.location || "ikke angivet"}`);
    sms.push(`nyt sted ${after.location || "ikke angivet"}`);
  }
  if (before.title !== after.title) {
    lines.push(`Navn: ${before.title} -> ${after.title}`);
    sms.push(`nyt navn ${after.title}`);
  }
  if (lines.length === 0) return;
  const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, after.teamId));
  await notifyUsers(db, deliver, await teamRecipients(db, after.teamId, ctx.now, ctx.userId), {
    kind: "event_change",
    subject: `Ændret: ${label(after)}, ${team.name}`,
    body: `${team.name}: ${label(after)} er ændret.\n\n${lines.join("\n")}\n\nSe aktiviteten: ${deliver.baseUrl}/aktivitet/${after.id}`,
    sms: `HoldLiv ${team.name}: ${label(after)} ${sms.join(", ")}`,
    eventId: after.id,
    url: `/aktivitet/${after.id}`,
  });
}

/** Ret en aktivitet og giv holdets familier besked, hvis tid, sted eller navn ændres. */
export async function updateEventNotifying(db: Db, ctx: AccessContext, deliver: Deliver, eventId: string, patch: Partial<EventInput>) {
  const [before] = await db.select().from(events).where(eq(events.id, eventId));
  const seatsBefore = await confirmedProfileIds(db, eventId);
  const after = await updateEvent(db, ctx, eventId, patch);
  await notifyPromoted(db, deliver, ctx, eventId, seatsBefore);
  if (before && after) {
    try {
      await announceChange(db, deliver, ctx, before, after);
    } catch (e) {
      console.error("[notify] kunne ikke sende besked om ændring", e);
    }
  }
  return after;
}

/** Aflys eller genopret og giv holdets familier besked. Flere aktiviteter i en serie bliver til én samlet besked. */
export async function setEventCancelledNotifying(
  db: Db,
  ctx: AccessContext,
  deliver: Deliver,
  eventId: string,
  cancelled: boolean,
  scope: "one" | "following" = "one",
) {
  const changed = await setEventCancelled(db, ctx, eventId, cancelled, scope);
  try {
    const rows = await db
      .select()
      .from(events)
      .where(inArray(events.id, changed.map((c) => c.id)));
    const upcoming = rows.filter((e) => e.startsAt.getTime() > ctx.now.getTime()).sort((a, b) => +a.startsAt - +b.startsAt);
    if (upcoming.length === 0) return changed;
    const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, upcoming[0].teamId));
    const verb = cancelled ? "aflyst" : "ikke aflyst alligevel";
    const shown = upcoming.slice(0, 5).map((e) => `- ${label(e)}, ${when(e.startsAt)}`);
    const more = upcoming.length > 5 ? [`og ${upcoming.length - 5} flere`] : [];
    const first = upcoming[0];
    const head =
      upcoming.length === 1
        ? `${label(first)} ${when(first.startsAt)} er ${verb}.`
        : `${upcoming.length} aktiviteter er ${verb}:\n${[...shown, ...more].join("\n")}`;
    await notifyUsers(db, deliver, await teamRecipients(db, first.teamId, ctx.now, ctx.userId), {
      kind: "event_change",
      subject: `${cancelled ? "Aflyst" : "Genoptaget"}: ${upcoming.length === 1 ? label(first) : `${upcoming.length} aktiviteter`}, ${team.name}`,
      body: `${team.name}: ${head}\n\nSe kalenderen: ${deliver.baseUrl}/hold/${first.teamId}`,
      sms:
        upcoming.length === 1
          ? `HoldLiv ${team.name}: ${label(first)} ${shortDay(first.startsAt)} kl. ${time(first.startsAt)} er ${verb}`
          : `HoldLiv ${team.name}: ${upcoming.length} aktiviteter er ${verb}, fra ${shortDay(first.startsAt)}`,
      eventId: first.id,
      url: upcoming.length === 1 ? `/aktivitet/${first.id}` : `/hold/${first.teamId}`,
    });
  } catch (e) {
    console.error("[notify] kunne ikke sende besked om aflysning", e);
  }
  return changed;
}

/** De seneste beskeder til et login, til indstillingssiden. */
export async function listMyNotifications(db: Db, ctx: AccessContext, limit = 15) {
  return db
    .select({ id: notifications.id, kind: notifications.kind, channel: notifications.channel, subject: notifications.subject, status: notifications.status, createdAt: notifications.createdAt })
    .from(notifications)
    .where(eq(notifications.userId, ctx.userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

/** Eget mobilnummer, så man kan vælge SMS. Tomt felt fjerner nummeret og slår SMS fra. */
export async function updateMyPhone(db: Db, ctx: AccessContext, phone: string) {
  const value = phone.trim();
  if (value && !normalizePhone(value)) throw new Error("Skriv et dansk mobilnummer med 8 cifre.");
  await db.update(profiles).set({ phone: value || null }).where(eq(profiles.id, ctx.profileId));
  if (!value) await db.update(notificationPrefs).set({ enabled: false }).where(and(eq(notificationPrefs.userId, ctx.userId), eq(notificationPrefs.channel, "sms")));
}

// --- Påmindelser om ubesvarede aktiviteter ---

const REMINDER_LEAD_MS = 24 * 3600 * 1000;

/**
 * Minder spillere og forældre om at svare på aktiviteter, de ikke har meldt til eller fra.
 * En påmindelse er "moden" 24 timer før svarfristen (eller før starten, hvis der ingen frist er) og sendes
 * højst én gang pr. aktivitet og login, også selv om funktionen køres hvert kvarter. Forældre med flere børn
 * på samme aktivitet får én besked med alle børnenes navne.
 */
export async function sendUnansweredReminders(db: Db, deliver: Deliver, now = new Date()) {
  const upcoming = await db
    .select()
    .from(events)
    .where(and(isNull(events.cancelledAt), gt(events.startsAt, now)));
  const due = upcoming.filter((e) => {
    const closes = e.responseDeadline ?? e.startsAt;
    return closes.getTime() > now.getTime() && closes.getTime() - REMINDER_LEAD_MS <= now.getTime();
  });
  const total = { events: 0, sent: 0, skipped: 0, failed: 0 };
  for (const e of due) {
    const [players, answered, [team]] = await Promise.all([
      db
        .select({ id: profiles.id, firstName: profiles.firstName, userId: profiles.userId })
        .from(teamMembers)
        .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
        .where(and(eq(teamMembers.teamId, e.teamId), eq(teamMembers.role, "player"))),
      db.select({ id: eventResponses.profileId }).from(eventResponses).where(eq(eventResponses.eventId, e.id)),
      db.select({ name: teams.name }).from(teams).where(eq(teams.id, e.teamId)),
    ]);
    const answeredIds = new Set(answered.map((a) => a.id));
    const missing = players.filter((p) => !answeredIds.has(p.id));
    if (missing.length === 0) continue;

    // Samler pr. login, hvem der mangler svar.
    const byUser = new Map<string, { recipient: Recipient; names: string[] }>();
    for (const p of missing) {
      for (const r of await recipientsOfPlayers(db, [p.id], now)) {
        const entry = byUser.get(r.userId) ?? { recipient: r, names: [] };
        entry.names.push(p.userId === r.userId ? "dig" : p.firstName);
        byUser.set(r.userId, entry);
      }
    }
    let any = false;
    const closes = e.responseDeadline ? `Svarfristen er ${when(e.responseDeadline)}.` : `Den er ${when(e.startsAt)}.`;
    for (const { recipient, names } of byUser.values()) {
      const who = names.join(" og ");
      const r = await notifyUsers(db, deliver, [recipient], {
        kind: "event_reminder",
        subject: `Husk at svare: ${label(e)}, ${team.name}`,
        body: `${team.name}: ${label(e)} mangler svar for ${who}. ${closes}\n\nSvar her: ${deliver.baseUrl}/aktivitet/${e.id}`,
        sms: `HoldLiv ${team.name}: ${label(e)} mangler svar for ${who}. ${deliver.baseUrl}/aktivitet/${e.id}`,
        eventId: e.id,
        url: `/aktivitet/${e.id}`,
        dedupeKey: `reminder:${e.id}`,
      });
      if (r.sent > 0) any = true;
      total.sent += r.sent;
      total.skipped += r.skipped;
      total.failed += r.failed;
    }
    if (any) total.events++;
  }
  return total;
}

// --- Push-abonnementer ---

export interface PushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Gemmer browserens abonnement på det loggede ind login og dets session. Samme browser kan skifte login, så endpoint overtages. */
export async function savePushSubscription(db: Db, ctx: AccessContext, sessionId: string, sub: PushSubscriptionInput) {
  if (!/^https:\/\//.test(sub.endpoint) || !sub.p256dh || !sub.auth) throw new Error("Browseren sendte et ugyldigt push-abonnement.");
  await db
    .insert(pushSubscriptions)
    .values({ userId: ctx.userId, sessionId, ...sub })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: ctx.userId, sessionId, p256dh: sub.p256dh, auth: sub.auth } });
}

export async function removePushSubscription(db: Db, ctx: AccessContext, endpoint: string) {
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, ctx.userId), eq(pushSubscriptions.endpoint, endpoint)));
}

export async function countMyPushSubscriptions(db: Db, ctx: AccessContext) {
  return (await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, ctx.userId))).length;
}

// --- Venteliste ---

/** Fortæl dem, der er rykket op fra ventelisten siden `before`. */
async function notifyPromoted(db: Db, deliver: Deliver, ctx: AccessContext, eventId: string, before: Set<string>, exceptProfileId?: string) {
  try {
    const after = await confirmedProfileIds(db, eventId);
    const promoted = [...after].filter((id) => !before.has(id) && id !== exceptProfileId);
    if (promoted.length === 0) return;
    const [e] = await db.select().from(events).where(eq(events.id, eventId));
    if (!e || e.cancelledAt || e.startsAt.getTime() <= ctx.now.getTime()) return;
    const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, e.teamId));
    const names = await db.select({ id: profiles.id, firstName: profiles.firstName, userId: profiles.userId }).from(profiles).where(inArray(profiles.id, promoted));
    for (const p of names) {
      const recipients = await recipientsOfPlayers(db, [p.id], ctx.now);
      for (const r of recipients) {
        const who = p.userId === r.userId ? "Du" : p.firstName;
        await notifyUsers(db, deliver, [r], {
          kind: "waitlist",
          subject: `Der er en plads: ${label(e)}, ${team.name}`,
          body: `${team.name}: ${who} har fået en plads på ${label(e)} ${when(e.startsAt)}, fordi en plads blev ledig.\n\nSe aktiviteten: ${deliver.baseUrl}/aktivitet/${e.id}`,
          sms: `HoldLiv ${team.name}: ${who} har fået en plads på ${label(e)} ${shortDay(e.startsAt)}`,
          eventId: e.id,
          url: `/aktivitet/${e.id}`,
          dedupeKey: `promoted:${e.id}:${p.id}:${r.userId}`,
        });
      }
    }
  } catch (err) {
    console.error("[notify] kunne ikke sende besked om ledig plads", err);
  }
}

/** Som respondToEvent, men giver besked til dem, der rykker op fra ventelisten, når en plads bliver ledig. */
export async function respondToEventNotifying(
  db: Db,
  ctx: AccessContext,
  deliver: Deliver,
  eventId: string,
  profileId: string,
  status: "yes" | "no" | "maybe",
  comment?: string | null,
) {
  const before = await confirmedProfileIds(db, eventId);
  await respondToEvent(db, ctx, eventId, profileId, status, comment);
  await notifyPromoted(db, deliver, ctx, eventId, before, profileId);
}
