import type { NextRequest } from "next/server";
import { db } from "../../../../../lib/db";
import { getDevicePushSender } from "../../../../../lib/devicePush";
import { getPushSender } from "../../../../../lib/push";
import { origin } from "../../../../../lib/origin";
import { sendMail } from "../../../../../lib/mail";
import { getSmsSender } from "../../../../../lib/sms";
import { respondToEventNotifying } from "../../../../../services";
import { authed, bodyOf, guard, ok, text } from "../../_lib";

export const dynamic = "force-dynamic";

/** Svar ja, nej eller måske for mig selv eller et barn. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const { ctx } = await authed(req);
    const b = await bodyOf(req);
    const status = text(b.status);
    if (status !== "yes" && status !== "no" && status !== "maybe") throw new Error("Svar ja, nej eller måske.");
    const deliver = { mail: sendMail, sms: getSmsSender(), push: getPushSender(), devicePush: getDevicePushSender(), baseUrl: await origin() };
    await respondToEventNotifying(db, ctx, deliver, text(b.eventId), text(b.profileId), status, typeof b.comment === "string" ? b.comment.trim() || null : undefined);
    return ok();
  });
}
