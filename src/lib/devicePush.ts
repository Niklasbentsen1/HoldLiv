// Push til mobilappen. Grænsefladen er den samme uanset udbyder; Expo's push-tjeneste er den rigtige, en mock bruges
// under udvikling. APNs- og FCM-nøgler lægges i Expo (EAS), ikke her. EXPO_PUSH=1 slår den rigtige til.
export interface DevicePushMessage {
  title: string;
  body: string;
  /** En sti i appen eller på HoldLiv, som et tryk fører hen til. */
  url: string;
}
export type DevicePushSender = (token: string, msg: DevicePushMessage) => Promise<void>;

/** Enheden er afmeldt eller appen afinstalleret, så adressen skal slettes. */
export class DeviceGoneError extends Error {}

const g = globalThis as unknown as { holdlivDevicePush?: { token: string; msg: DevicePushMessage }[] };
export const devicePushInbox = (g.holdlivDevicePush ??= []);

export const mockDevicePush: DevicePushSender = async (token, msg) => {
  devicePushInbox.push({ token, msg });
  console.log(`[mobil-push] til ${token.slice(0, 30)}…: ${msg.title}`);
};

const EXPO_URL = "https://exp.host/--/api/v2/push/send";

export const expoPush: DevicePushSender = async (token, msg) => {
  const res = await fetch(EXPO_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(process.env.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
    },
    body: JSON.stringify({ to: token, title: msg.title, body: msg.body, data: { url: msg.url }, sound: "default" }),
  });
  if (!res.ok) throw new Error(`Expo svarede ${res.status}`);
  const json = (await res.json()) as { data?: { status?: string; message?: string; details?: { error?: string } } };
  if (json.data?.status === "error") {
    if (json.data.details?.error === "DeviceNotRegistered") throw new DeviceGoneError("Enheden er ikke tilmeldt længere");
    throw new Error(json.data.message ?? "Expo afviste beskeden");
  }
};

export function getDevicePushSender(): DevicePushSender | null {
  if (process.env.EXPO_PUSH === "1") return expoPush;
  return process.env.NODE_ENV !== "production" ? mockDevicePush : null;
}

export const isExpoToken = (t: string) => /^Expo(nent)?PushToken\[[\w-]+\]$/.test(t);
