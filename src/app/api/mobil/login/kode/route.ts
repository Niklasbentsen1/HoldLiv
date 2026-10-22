import type { NextRequest } from "next/server";
import { createSession, verifyCode } from "../../../../../auth/login";
import { logLogin } from "../../../../../auth/mfa";
import { db } from "../../../../../lib/db";
import { bodyOf, guard, ok, text } from "../../_lib";

export const dynamic = "force-dynamic";

/** Trin 2: kode fra e-mailen. Svaret er et token; har kontoen to-faktor, giver det først adgang efter /login/to-faktor. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const b = await bodyOf(req);
    const userId = await verifyCode(db, text(b.email), text(b.code));
    const { token, expiresAt, mfaPending } = await createSession(db, userId);
    if (!mfaPending) await logLogin(db, userId);
    return ok({ token, expiresAt, mfaRequired: mfaPending });
  });
}
