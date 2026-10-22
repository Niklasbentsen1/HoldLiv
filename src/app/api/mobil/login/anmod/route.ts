import type { NextRequest } from "next/server";
import { requestLogin } from "../../../../../auth/login";
import { db } from "../../../../../lib/db";
import { sendLoginMail } from "../../../../../lib/mail";
import { origin } from "../../../../../lib/origin";
import { bodyOf, guard, ok, text } from "../../_lib";

export const dynamic = "force-dynamic";

/** Trin 1: send en kode til e-mailen. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const r = await requestLogin(db, text((await bodyOf(req)).email));
    await sendLoginMail(r.email, r.code, `${await origin()}/login/link?token=${r.linkToken}`);
    return ok();
  });
}
