import type { NextRequest } from "next/server";
import { completeMfa, MfaError } from "../../../../../auth/mfa";
import { db } from "../../../../../lib/db";
import { bodyOf, guard, ok, text } from "../../_lib";

export const dynamic = "force-dynamic";

/** Trin 3 (kun med to-faktor): kode fra autentificeringsappen eller en nødkode. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const token = /^Bearer (\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!token) throw new MfaError("Log ind først.");
    await completeMfa(db, token, text((await bodyOf(req)).code));
    return ok();
  });
}
