// Klient til HoldLivs mobil-API (/api/mobil). Adressen sættes med EXPO_PUBLIC_API_URL.
import { loadToken } from "./storage";

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, token?: string | null): Promise<T> {
  const bearer = token === undefined ? await loadToken() : token;
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/mobil${path}`, {
      method,
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Kan ikke få forbindelse. Tjek dit netværk.", 0);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(json.error ?? "Noget gik galt.", res.status);
  return json as T;
}

export interface Person {
  id: string;
  name: string;
  self: boolean;
}
export type Status = "yes" | "no" | "maybe";
export interface EventItem {
  id: string;
  type: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  responseDeadline: string | null;
  cancelledAt: string | null;
  teamId: string;
  teamName: string;
  status: Status | null;
  comment: string | null;
}

export const api = {
  requestCode: (email: string) => call<{ ok: true }>("POST", "/login/anmod", { email }, null),
  verifyCode: (email: string, code: string) => call<{ token: string; mfaRequired: boolean }>("POST", "/login/kode", { email, code }, null),
  verifyMfa: (token: string, code: string) => call<{ ok: true }>("POST", "/login/to-faktor", { code }, token),
  me: () => call<{ people: Person[] }>("GET", "/mig"),
  events: (profileId: string) => call<{ events: EventItem[] }>("GET", `/aktiviteter?profil=${encodeURIComponent(profileId)}`),
  respond: (eventId: string, profileId: string, status: Status) => call<{ ok: true }>("POST", "/aktiviteter/svar", { eventId, profileId, status }),
  registerDevice: (token: string, platform: string) => call<{ ok: true }>("POST", "/enhed", { token, platform }),
  removeDevice: (token: string) => call<{ ok: true }>("DELETE", "/enhed", { token }),
  logout: () => call<{ ok: true }>("POST", "/logud"),
};
