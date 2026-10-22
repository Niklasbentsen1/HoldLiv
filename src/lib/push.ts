// Push-beskeder i browseren (Web Push). Med VAPID_PUBLIC_KEY og VAPID_PRIVATE_KEY sendes rigtige beskeder.
// Uden nøgler bruges en mock under udvikling og demo (skriver kun i loggen); i produktion springes push over.
// Lav nøgler med: npx web-push generate-vapid-keys
import webpush from "web-push";

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}
export type PushSender = (to: PushTarget, payload: string) => Promise<void>;

/** Browseren har trukket sit abonnement tilbage, så det skal slettes. */
export class PushGoneError extends Error {}

const g = globalThis as unknown as { holdlivPush?: { to: string; payload: string }[] };
export const pushInbox = (g.holdlivPush ??= []);

export const mockPush: PushSender = async (to, payload) => {
  pushInbox.push({ to: to.endpoint, payload });
  console.log(`[push] til ${to.endpoint.slice(0, 40)}…: ${payload}`);
};

export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY ?? null;

const realPush: PushSender = async (to, payload) => {
  try {
    await webpush.sendNotification({ endpoint: to.endpoint, keys: { p256dh: to.p256dh, auth: to.auth } }, payload, {
      vapidDetails: { subject: process.env.VAPID_SUBJECT ?? "mailto:login@holdliv.dk", publicKey: process.env.VAPID_PUBLIC_KEY!, privateKey: process.env.VAPID_PRIVATE_KEY! },
      TTL: 12 * 3600,
    });
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) throw new PushGoneError("Abonnementet er udløbet");
    throw e;
  }
};

export function getPushSender(): PushSender | null {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) return realPush;
  return process.env.NODE_ENV !== "production" ? mockPush : null;
}
