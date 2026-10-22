// Mobilappens grænseflade. Appen bruger sessionens nøgle som bearer-token (samme som cookien på nettet), så logins, to-faktor
// og rettigheder virker ens. Her ligger det, appen har brug for ud over de fælles tjenester.
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { deviceTokens, profiles } from "../db/schema";
import { loadAccessContext } from "../auth/context";
import { resolveSession, sha256 } from "../auth/login";
import { mfaStatus } from "../auth/mfa";
import type { AccessContext } from "../auth/permissions";
import { isExpoToken } from "../lib/devicePush";
import { listUpcomingEvents } from "./index";

export class MobileAuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

/** Finder login'et bag `Authorization: Bearer <token>`. Kaster MobileAuthError, hvis det ikke er i orden. */
export async function authenticateMobile(db: Db, authorization: string | null, now = new Date()): Promise<{ ctx: AccessContext; sessionId: string }> {
  const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (!token) throw new MobileAuthError("Log ind først.", 401);
  const userId = await resolveSession(db, token, now);
  if (!userId) throw new MobileAuthError("Din session er udløbet. Log ind igen.", 401);
  const ctx = await loadAccessContext(db, userId, now).catch(() => null);
  if (!ctx) throw new MobileAuthError("Udfyld din profil på holdliv.dk først.", 403);
  // Samme krav som på nettet: admin og kasserer skal have to-faktor, når det er påkrævet.
  if (ctx.adminClubs.size > 0 || ctx.treasurerClubs.size > 0) {
    const m = await mfaStatus(db, userId);
    if (m.required && !m.enabled) throw new MobileAuthError("Slå to-faktor til på nettet, før du bruger appen.", 403);
  }
  return { ctx, sessionId: sha256(token) };
}

/** Hvem man kan handle for: en selv og ens børn. */
export async function mobilePeople(db: Db, ctx: AccessContext) {
  const ids = [ctx.profileId, ...ctx.wards];
  const rows = await Promise.all(ids.map((id) => db.select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName }).from(profiles).where(eq(profiles.id, id))));
  return rows.flat().map((p) => ({ id: p.id, name: `${p.firstName} ${p.lastName}`, self: p.id === ctx.profileId }));
}

/** Kommende aktiviteter for én person (en selv eller et barn). */
export async function mobileEvents(db: Db, ctx: AccessContext, profileId: string) {
  return listUpcomingEvents(db, ctx, profileId, ctx.now);
}

export async function registerDevice(db: Db, ctx: AccessContext, sessionId: string, device: { token: string; platform: string }) {
  if (!isExpoToken(device.token)) throw new Error("Ugyldig push-adresse.");
  if (device.platform !== "ios" && device.platform !== "android") throw new Error("Ukendt platform.");
  await db
    .insert(deviceTokens)
    .values({ userId: ctx.userId, sessionId, platform: device.platform, token: device.token })
    .onConflictDoUpdate({ target: deviceTokens.token, set: { userId: ctx.userId, sessionId, platform: device.platform } });
}

export async function removeDevice(db: Db, ctx: AccessContext, token: string) {
  await db.delete(deviceTokens).where(and(eq(deviceTokens.userId, ctx.userId), eq(deviceTokens.token, token)));
}
