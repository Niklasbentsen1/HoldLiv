// To-faktor for admin og kasserer. TOTP med nødkoder. En session for en konto med to-faktor er "afventende"
// (sessions.mfa_pending), indtil koden er tastet; så giver den ingen adgang.
import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubRoles, profiles, recoveryCodes, sessions, users } from "../db/schema";
import { logAudit } from "../services/audit";
import { matchStep, newSecret, openSecret, otpauthUri, sealSecret } from "../lib/totp";
import { sha256 } from "./login";

export const MAX_MFA_ATTEMPTS = 5;
export const RECOVERY_CODE_COUNT = 8;

export class MfaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MfaError";
  }
}

/** Kræves to-faktor for de roller? Slås til med REQUIRE_2FA=1 (i produktion), så demoen ikke spærres. */
export const mfaEnforced = () => process.env.REQUIRE_2FA === "1";

async function privilegedClubs(db: Db, userId: string) {
  const rows = await db
    .select({ clubId: clubRoles.clubId })
    .from(clubRoles)
    .innerJoin(profiles, eq(profiles.id, clubRoles.profileId))
    .where(eq(profiles.userId, userId));
  return rows.map((r) => r.clubId);
}

/** Logger et login for de foreninger, hvor personen er admin eller kasserer. */
export async function logLogin(db: Db, userId: string) {
  for (const clubId of await privilegedClubs(db, userId)) await logAudit(db, { action: "login.ok", clubId, actorUserId: userId });
}

export async function mfaStatus(db: Db, userId: string) {
  const [u] = await db
    .select({ enabledAt: users.totpEnabledAt, email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  const [{ left }] = await db
    .select({ left: sql<number>`count(*)::int` })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)));
  const clubs = await privilegedClubs(db, userId);
  return { enabled: !!u?.enabledAt, recoveryLeft: left, privileged: clubs.length > 0, required: mfaEnforced() && clubs.length > 0 };
}

/** Trin 1: giver en ny hemmelighed og adressen til QR-koden. Intet er slået til, før koden er bekræftet. */
export async function beginTotpSetup(db: Db, userId: string) {
  const [u] = await db.select({ email: users.email, enabledAt: users.totpEnabledAt }).from(users).where(eq(users.id, userId));
  if (u.enabledAt) throw new MfaError("To-faktor er allerede slået til.");
  const secret = newSecret();
  await db.update(users).set({ totpPendingSecret: sealSecret(secret) }).where(eq(users.id, userId));
  return { secret, uri: otpauthUri(secret, u.email) };
}

function freshRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = randomBytes(5).toString("hex");
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
const normRecovery = (c: string) => c.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
const recoveryHash = (userId: string, c: string) => sha256(`${userId}:${normRecovery(c)}`);

/** Trin 2: bekræft med en kode fra appen. Returnerer nødkoderne, som kun vises denne ene gang. */
export async function confirmTotpSetup(db: Db, userId: string, code: string, now = new Date()) {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (u.totpEnabledAt) throw new MfaError("To-faktor er allerede slået til.");
  if (!u.totpPendingSecret) throw new MfaError("Start opsætningen forfra.");
  const step = matchStep(openSecret(u.totpPendingSecret), code, now);
  if (step === null) throw new MfaError("Koden passer ikke. Tjek, at telefonens ur er rigtigt, og prøv igen.");
  const codes = freshRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ totpSecret: u.totpPendingSecret, totpPendingSecret: null, totpEnabledAt: now, totpLastStep: step })
      .where(eq(users.id, userId));
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await tx.insert(recoveryCodes).values(codes.map((c) => ({ userId, codeHash: recoveryHash(userId, c) })));
  });
  for (const clubId of await privilegedClubs(db, userId)) await logAudit(db, { action: "mfa.enabled", clubId, actorUserId: userId });
  return codes;
}

/** Slår to-faktor fra (kræver en gyldig kode). Spærret for admin og kasserer, når to-faktor er påkrævet. */
export async function disableTotp(db: Db, userId: string, code: string, now = new Date()) {
  if ((await mfaStatus(db, userId)).required) throw new MfaError("Som admin eller kasserer skal du bruge to-faktor.");
  await checkSecondFactor(db, userId, code, now);
  await db.update(users).set({ totpSecret: null, totpPendingSecret: null, totpEnabledAt: null, totpLastStep: null }).where(eq(users.id, userId));
  await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
  for (const clubId of await privilegedClubs(db, userId)) await logAudit(db, { action: "mfa.disabled", clubId, actorUserId: userId });
}

/** Tjekker en app-kode (én gang pr. tidsrum) eller en nødkode (én gang). Kaster MfaError ved fejl. */
async function checkSecondFactor(db: Db, userId: string, code: string, now: Date): Promise<"totp" | "recovery"> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u?.totpSecret) throw new MfaError("To-faktor er ikke slået til.");
  const step = matchStep(openSecret(u.totpSecret), code, now);
  if (step !== null) {
    // Samme kode må ikke bruges to gange (genafspilning): kun et nyere step tæller.
    const used = await db
      .update(users)
      .set({ totpLastStep: step })
      .where(and(eq(users.id, userId), sql`(${users.totpLastStep} is null or ${users.totpLastStep} < ${step})`))
      .returning({ id: users.id });
    if (used.length === 0) throw new MfaError("Koden er allerede brugt. Vent på den næste.");
    return "totp";
  }
  if (/^[0-9a-f]{5}-?[0-9a-f]{5}$/i.test(code.trim())) {
    const used = await db
      .update(recoveryCodes)
      .set({ usedAt: now })
      .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, recoveryHash(userId, code)), isNull(recoveryCodes.usedAt)))
      .returning({ id: recoveryCodes.id });
    if (used.length > 0) return "recovery";
  }
  throw new MfaError("Forkert kode.");
}

/** Nye nødkoder (de gamle slettes). Kræver en gyldig kode. */
export async function regenerateRecoveryCodes(db: Db, userId: string, code: string, now = new Date()) {
  await checkSecondFactor(db, userId, code, now);
  const codes = freshRecoveryCodes();
  await db.transaction(async (tx) => {
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    await tx.insert(recoveryCodes).values(codes.map((c) => ({ userId, codeHash: recoveryHash(userId, c) })));
  });
  return codes;
}

export async function hasTotp(db: Db, userId: string) {
  const [u] = await db.select({ at: users.totpEnabledAt }).from(users).where(eq(users.id, userId));
  return !!u?.at;
}

/** Fuldfør login for en afventende session. Efter for mange fejl slettes sessionen. */
export async function completeMfa(db: Db, sessionToken: string, code: string, now = new Date()) {
  const id = sha256(sessionToken);
  const [s] = await db.select().from(sessions).where(and(eq(sessions.id, id), eq(sessions.mfaPending, true)));
  if (!s || s.expiresAt <= now) throw new MfaError("Login'et er udløbet. Log ind forfra.");
  const [{ attempts }] = await db
    .update(sessions)
    .set({ mfaAttempts: sql`${sessions.mfaAttempts} + 1` })
    .where(eq(sessions.id, id))
    .returning({ attempts: sessions.mfaAttempts });
  const clubs = await privilegedClubs(db, s.userId);
  if (attempts > MAX_MFA_ATTEMPTS) {
    await db.delete(sessions).where(eq(sessions.id, id));
    throw new MfaError("For mange forkerte koder. Log ind forfra.");
  }
  let kind: "totp" | "recovery";
  try {
    kind = await checkSecondFactor(db, s.userId, code, now);
  } catch (e) {
    for (const clubId of clubs) await logAudit(db, { action: "login.mfa_failed", clubId, actorUserId: s.userId });
    throw e;
  }
  await db.update(sessions).set({ mfaPending: false }).where(eq(sessions.id, id));
  for (const clubId of clubs) {
    await logAudit(db, { action: "login.ok", clubId, actorUserId: s.userId, detail: { mfa: kind } });
    if (kind === "recovery") await logAudit(db, { action: "mfa.recovery_used", clubId, actorUserId: s.userId });
  }
}

export async function isMfaPending(db: Db, sessionToken: string, now = new Date()) {
  const [s] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, sha256(sessionToken)), eq(sessions.mfaPending, true), sql`${sessions.expiresAt} > ${now}`));
  return !!s;
}

