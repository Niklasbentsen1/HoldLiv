// Henvendelser til HoldLiv-support fra hjælpecenteret. Kræver login, så e-mailen er bekræftet og misbrug kan begrænses.
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubs, supportRequests, users } from "../db/schema";
import type { AccessContext } from "../auth/permissions";
import type { Mailer } from "../lib/mail";
import { logAudit } from "./audit";

export const MAX_SUBJECT = 120;
export const MAX_MESSAGE = 3000;
export const MAX_REQUESTS_PER_DAY = 5;

export async function submitSupportRequest(
  db: Db,
  ctx: AccessContext,
  input: { subject: string; message: string; clubId?: string | null },
  mail?: { send: Mailer; to: string | undefined },
) {
  const subject = input.subject.trim().replace(/\s+/g, " ");
  const message = input.message.trim();
  if (!subject) throw new Error("Skriv, hvad henvendelsen handler om.");
  if (subject.length > MAX_SUBJECT) throw new Error(`Emnet må højst være ${MAX_SUBJECT} tegn.`);
  if (!message) throw new Error("Skriv din besked.");
  if (message.length > MAX_MESSAGE) throw new Error(`Beskeden må højst være ${MAX_MESSAGE} tegn.`);
  // Kun en forening, man selv er admin i, kan knyttes til henvendelsen.
  const clubId = input.clubId && ctx.adminClubs.has(input.clubId) ? input.clubId : null;
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId));
  if (!u) throw new Error("Login'et findes ikke.");
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const request = await db.transaction(async (tx) => {
    // Samtidige kald fra samme login står i kø, så døgngrænsen holder.
    await tx.execute(sqlLock(ctx.userId));
    const [{ n }] = await tx.select({ n: count() }).from(supportRequests).where(and(eq(supportRequests.userId, ctx.userId), gte(supportRequests.createdAt, since)));
    if (n >= MAX_REQUESTS_PER_DAY) throw new Error(`Du har sendt ${MAX_REQUESTS_PER_DAY} henvendelser i dag. Prøv igen i morgen.`);
    const [r] = await tx.insert(supportRequests).values({ userId: ctx.userId, clubId, subject, message, replyEmail: u.email }).returning();
    return r;
  });
  await logAudit(db, { action: "support.requested", clubId, actorUserId: ctx.userId, targetType: "support_request", targetId: request.id });
  if (!mail?.to) {
    // Uden SUPPORT_EMAIL ligger henvendelsen kun i databasen, og ingen får besked. Det skal ikke ske i produktion uden at nogen kan se det.
    if (process.env.NODE_ENV === "production") console.error("SUPPORT_EMAIL mangler: support-henvendelsen er gemt, men ingen er underrettet", request.id);
  } else {
    const [club] = clubId ? await db.select({ name: clubs.name }).from(clubs).where(eq(clubs.id, clubId)) : [];
    try {
      await mail.send(mail.to, `[Support] ${subject}`, `Fra: ${u.email}${club ? `\nForening: ${club.name}` : ""}\nHenvendelse: ${request.id}\n\n${message}`, { replyTo: u.email });
    } catch (e) {
      // Henvendelsen er gemt; en mailfejl må ikke få den til at se tabt ud.
      console.error("Support-mail fejlede", e);
    }
  }
  return request;
}

export async function listMySupportRequests(db: Db, ctx: AccessContext) {
  return db.select().from(supportRequests).where(eq(supportRequests.userId, ctx.userId)).orderBy(desc(supportRequests.createdAt)).limit(20);
}

const sqlLock = (userId: string) => sql`select pg_advisory_xact_lock(hashtext(${"support:" + userId}))`;
