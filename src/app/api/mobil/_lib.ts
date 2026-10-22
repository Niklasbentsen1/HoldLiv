// Fælles hjælp til mobilappens JSON-endpoints.
import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError } from "../../../auth/permissions";
import { LoginError } from "../../../auth/login";
import { MfaError } from "../../../auth/mfa";
import { db } from "../../../lib/db";
import { authenticateMobile, MobileAuthError } from "../../../services";

export const dynamic = "force-dynamic";

export const ok = (data: unknown = { ok: true }) => NextResponse.json(data, { headers: { "cache-control": "no-store" } });

/** Kører en handler og gør kendte fejl om til JSON med en dansk besked, som appen viser. */
export async function guard(fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MobileAuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof ForbiddenError) return NextResponse.json({ error: "Det har du ikke adgang til." }, { status: 403 });
    if (e instanceof LoginError || e instanceof MfaError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof Error && e.name !== "TypeError") return NextResponse.json({ error: e.message }, { status: 400 });
    console.error(e);
    return NextResponse.json({ error: "Noget gik galt." }, { status: 500 });
  }
}

export async function bodyOf(req: NextRequest): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
}
export const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export const authed = (req: NextRequest) => authenticateMobile(db, req.headers.get("authorization"));
