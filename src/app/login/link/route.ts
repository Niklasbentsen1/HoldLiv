import { NextResponse, type NextRequest } from "next/server";
import { LoginError, verifyLink } from "../../../auth/login";
import { db } from "../../../lib/db";
import { safeNext, startSession } from "../../../lib/session";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  let pending = false;
  try {
    pending = await startSession(await verifyLink(db, token));
  } catch (e) {
    const message = e instanceof LoginError ? e.message : "Linket virker ikke.";
    return NextResponse.redirect(new URL(`/login?fejl=${encodeURIComponent(message)}`, req.url));
  }
  if (pending) return NextResponse.redirect(new URL(`/login/to-faktor?next=${encodeURIComponent(next)}`, req.url));
  return NextResponse.redirect(new URL(next, req.url));
}
