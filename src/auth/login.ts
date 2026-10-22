// Login uden kodeord. Man skriver sin e-mail og får en 6-cifret kode og et link.
// Begge virker én gang i 15 minutter. Kun hashes gemmes i databasen.
// Et nyt login oprettes første gang en e-mail bekræftes; profilen udfyldes bagefter.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { loginTokens, sessions, users } from "../db/schema";

export const CODE_TTL_MINUTES = 15;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_REQUESTS_PER_HOUR = 5;
export const SESSION_DAYS = 30;

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const codeHash = (email: string, code: string) => sha256(`${email}:${code}`);

export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new LoginError("Skriv en gyldig e-mailadresse");
  return e;
}

/** Laver en ny kode og et nyt link til e-mailen. Afsendelsen sker i lib/mail. */
export async function requestLogin(db: Db, rawEmail: string, now = new Date()) {
  const email = normalizeEmail(rawEmail);
  const hourAgo = new Date(now.getTime() - 3600_000);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(loginTokens)
    .where(and(eq(loginTokens.email, email), gt(loginTokens.createdAt, hourAgo)));
  if (count >= MAX_REQUESTS_PER_HOUR) throw new LoginError("For mange forsøg. Prøv igen om en time.");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const linkToken = randomBytes(32).toString("base64url");
  await db.insert(loginTokens).values({
    email,
    codeHash: codeHash(email, code),
    linkHash: sha256(linkToken),
    expiresAt: new Date(now.getTime() + CODE_TTL_MINUTES * 60_000),
    createdAt: now,
  });
  return { email, code, linkToken };
}

/** Tjekker koden fra e-mailen. Kun den nyeste kode gælder. Returnerer login'ets id. */
export async function verifyCode(db: Db, rawEmail: string, code: string, now = new Date()) {
  const email = normalizeEmail(rawEmail);
  const [token] = await db
    .select()
    .from(loginTokens)
    .where(and(eq(loginTokens.email, email), isNull(loginTokens.usedAt), gt(loginTokens.expiresAt, now)))
    .orderBy(desc(loginTokens.createdAt))
    .limit(1);
  if (!token) throw new LoginError("Koden er udløbet. Bed om en ny.");

  // Tæl forsøget op før sammenligningen, så parallelle gæt også tælles.
  const [{ attempts }] = await db
    .update(loginTokens)
    .set({ attempts: sql`${loginTokens.attempts} + 1` })
    .where(eq(loginTokens.id, token.id))
    .returning({ attempts: loginTokens.attempts });
  if (attempts > MAX_CODE_ATTEMPTS) throw new LoginError("For mange forkerte koder. Bed om en ny.");
  if (token.codeHash !== codeHash(email, code.replace(/\s/g, ""))) throw new LoginError("Forkert kode");

  await consume(db, token.id, now);
  return findOrCreateUser(db, email);
}

/** Tjekker linket fra e-mailen. */
export async function verifyLink(db: Db, linkToken: string, now = new Date()) {
  const [token] = await db
    .select()
    .from(loginTokens)
    .where(and(eq(loginTokens.linkHash, sha256(linkToken)), isNull(loginTokens.usedAt), gt(loginTokens.expiresAt, now)));
  if (!token) throw new LoginError("Linket er udløbet eller allerede brugt. Bed om et nyt.");
  await consume(db, token.id, now);
  return findOrCreateUser(db, token.email);
}

async function consume(db: Db, tokenId: string, now: Date) {
  const used = await db
    .update(loginTokens)
    .set({ usedAt: now })
    .where(and(eq(loginTokens.id, tokenId), isNull(loginTokens.usedAt)))
    .returning({ id: loginTokens.id });
  if (used.length === 0) throw new LoginError("Koden er allerede brugt. Bed om en ny.");
}

async function findOrCreateUser(db: Db, email: string): Promise<string> {
  const [created] = await db.insert(users).values({ email }).onConflictDoNothing().returning({ id: users.id });
  if (created) return created.id;
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  return existing.id;
}

/** Opretter en session. Returnerer værdien til cookien. */
export async function createSession(db: Db, userId: string, now = new Date(), opts: { skipMfa?: boolean } = {}) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  // Har kontoen to-faktor, giver sessionen først adgang, når koden er tastet (se auth/mfa.ts).
  const [u] = await db.select({ at: users.totpEnabledAt }).from(users).where(eq(users.id, userId));
  const mfaPending = !!u?.at && !opts.skipMfa;
  await db.insert(sessions).values({ id: sha256(token), userId, expiresAt, createdAt: now, mfaPending });
  return { token, expiresAt, mfaPending };
}

export async function resolveSession(db: Db, token: string, now = new Date()): Promise<string | null> {
  const [s] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, now), eq(sessions.mfaPending, false)));
  return s?.userId ?? null;
}

export async function deleteSession(db: Db, token: string) {
  await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}
