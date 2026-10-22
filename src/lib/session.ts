// Sessioner i cookies. Cookien indeholder en tilfældig nøgle; databasen kender kun dens hash.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loadAccessContext } from "../auth/context";
import { createSession, deleteSession, resolveSession } from "../auth/login";
import { isMfaPending, logLogin, mfaStatus } from "../auth/mfa";
import { canActAs } from "../auth/permissions";
import { db } from "./db";

export const SESSION_COOKIE = "holdliv_session";
export const ACTING_COOKIE = "holdliv_acting";

const cookieOptions = (expires?: Date) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  expires,
});

/** Returnerer true, hvis kontoen har to-faktor og koden skal tastes, før man kommer ind. */
export async function startSession(userId: string, opts: { skipMfa?: boolean } = {}) {
  const { token, expiresAt, mfaPending } = await createSession(db, userId, new Date(), opts);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
  jar.delete(ACTING_COOKIE);
  if (!mfaPending) await logLogin(db, userId);
  return mfaPending;
}

/** Er sessionen i cookien afventende på to-faktor-koden? */
export async function sessionAwaitsMfa() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? isMfaPending(db, token) : false;
}

export async function currentSessionToken() {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(db, token);
  jar.delete(SESSION_COOKIE);
  jar.delete(ACTING_COOKIE);
}

export async function setActingProfile(profileId: string) {
  (await cookies()).set(ACTING_COOKIE, profileId, cookieOptions());
}

/** Login'et bag cookien, eller null. */
export async function getUserId() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? resolveSession(db, token) : null;
}

/**
 * Login, rettigheder og hvem man agerer som. null hvis man ikke er logget ind eller mangler en profil.
 * actingProfileId er null, når man ser hele familien på én gang.
 */
export async function getSession(opts: { allowMfaSetup?: boolean } = {}) {
  const userId = await getUserId();
  if (!userId) return null;
  const ctx = await loadAccessContext(db, userId).catch(() => null);
  if (!ctx) return null;
  // Admin og kasserer skal have to-faktor, når REQUIRE_2FA=1: ellers til opsætningen.
  if (!opts.allowMfaSetup && (ctx.adminClubs.size > 0 || ctx.treasurerClubs.size > 0)) {
    const m = await mfaStatus(db, userId);
    if (m.required && !m.enabled) redirect("/indstillinger/to-faktor");
  }
  const wanted = (await cookies()).get(ACTING_COOKIE)?.value;
  const actingProfileId = wanted && canActAs(ctx, wanted) ? wanted : null;
  return { ctx, actingProfileId };
}

/** Til sider der kræver login. Sender til login eller til "udfyld din profil". */
export async function requireSession(next?: string) {
  const session = await getSession();
  if (session) return session;
  if (await sessionAwaitsMfa()) redirect(next ? `/login/to-faktor?next=${encodeURIComponent(next)}` : "/login/to-faktor");
  if (await getUserId()) redirect(next ? `/velkommen?next=${encodeURIComponent(next)}` : "/velkommen");
  redirect(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
}

/** Kun stier i appen, så et login-link ikke kan sende videre til en fremmed side. */
export function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
