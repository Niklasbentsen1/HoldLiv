import type { NextRequest } from "next/server";
import { db } from "../../../../lib/db";
import { mobileEvents } from "../../../../services";
import { authed, guard, ok, uuid } from "../_lib";

export const dynamic = "force-dynamic";

/** Kommende aktiviteter for ?profil=<id> (standard: mig selv). */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const { ctx } = await authed(req);
    const profile = req.nextUrl.searchParams.has("profil") ? uuid(req.nextUrl.searchParams.get("profil"), "profil") : ctx.profileId;
    return ok({ events: await mobileEvents(db, ctx, profile) });
  });
}
