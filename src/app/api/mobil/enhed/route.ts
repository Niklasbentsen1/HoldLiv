import type { NextRequest } from "next/server";
import { db } from "../../../../lib/db";
import { registerDevice, removeDevice } from "../../../../services";
import { authed, bodyOf, guard, ok, text } from "../_lib";

export const dynamic = "force-dynamic";

/** Tilmeld telefonen til push: { token: "ExponentPushToken[...]", platform: "ios" | "android" }. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const { ctx, sessionId } = await authed(req);
    const b = await bodyOf(req);
    await registerDevice(db, ctx, sessionId, { token: text(b.token), platform: text(b.platform) });
    return ok();
  });
}

export async function DELETE(req: NextRequest) {
  return guard(async () => {
    const { ctx } = await authed(req);
    await removeDevice(db, ctx, text((await bodyOf(req)).token));
    return ok();
  });
}
