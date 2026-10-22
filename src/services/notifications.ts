// Beskeder til forældre og spillere: mail og SMS (push kommer senere). Hvert login vælger selv kanaler pr. slags besked.
//
// Regler:
//   - En besked går til de logins, der hører til holdets spillere: spillerens eget login og forældre til børn under 18 år.
//     Den, der selv lavede ændringen, får ikke besked om den.
//   - Mail er slået til som standard, SMS er opt-in og kræver et telefonnummer. En kanal, der ikke er sat op eller
//     mangler modtager, springes over, og det noteres i `notifications`.
//   - En fejl hos mail- eller SMS-udbyderen får aldrig selve ændringen (fx en aflysning) til at fejle; den noteres.
//   - dedupe_key sørger for, at den samme besked ikke sendes to gange til samme login på samme kanal.
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { events, guardianships, notificationPrefs, notifications, profiles, teamMembers, teams, users } from "../db/schema";
import { isMinor, type AccessContext } from "../auth/permissions";
import { CHANNELS, DEFAULT_ENABLED, KINDS, type Channel, type Kind } from "../lib/notify";
import { normalizePhone, type SmsSender } from "../lib/sms";
import type { Mailer } from "../lib/mail";
import { TYPE_LABEL, shortDay, time, when } from "../lib/format";
import { setEventCancelled, updateEvent } from "./calendar";
import type { EventInput } from "./index";

export interface Deliver {
  mail: Mailer;
  /** Null, når der ikke er nogen SMS-udbyder. */
  sms: SmsSender | null;
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
      matrix[kind][channel] = rows.find((r) => r.kind === kind && r.channel === channel)?.enabled ?? DEFAULT_ENABLED[channel];
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

interface Recipient {
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
  /** Kort tekst til SMS. */
  sms: string;
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
  const footer = `\n\nVil du have beskeder på en anden måde? Ret det her: ${deliver.baseUrl}/indstillinger`;

  for (const r of recipients) {
    for (const channel of CHANNELS) {
      const enabled = prefsRows.find((p) => p.userId === r.userId && p.channel === channel)?.enabled ?? DEFAULT_ENABLED[channel];
      if (!enabled) continue;
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
  });
}

/** Ret en aktivitet og giv holdets familier besked, hvis tid, sted eller navn ændres. */
export async function updateEventNotifying(db: Db, ctx: AccessContext, deliver: Deliver, eventId: string, patch: Partial<EventInput>) {
  const [before] = await db.select().from(events).where(eq(events.id, eventId));
  const after = await updateEvent(db, ctx, eventId, patch);
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
