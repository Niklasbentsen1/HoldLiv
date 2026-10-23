// Køres af en planlagt opgave (fx hver time) med "Authorization: Bearer $CRON_SECRET".
// Sender påmindelser om vagter, kontrakter der venter på underskrift eller udløber, og børneattester der mangler samtykke eller udløber.
// Kan køres så ofte, man vil: hver besked sendes kun én gang pr. periode.
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { sendCertificateReminders, sendContractReminders, sendShiftReminders } from "../../../../services";
import { db } from "../../../../lib/db";
import { sendMail } from "../../../../lib/mail";
import { getDevicePushSender } from "../../../../lib/devicePush";
import { getPushSender } from "../../../../lib/push";
import { getSmsSender } from "../../../../lib/sms";

export const dynamic = "force-dynamic";

function authorized(req: NextRequest, secret: string) {
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET mangler" }, { status: 500 });
  if (!authorized(req, secret)) return NextResponse.json({ error: "Ikke tilladt" }, { status: 401 });
  const baseUrl = (process.env.APP_URL ?? req.nextUrl.origin).replace(/\/$/, "");
  const deliver = { mail: sendMail, sms: getSmsSender(), push: getPushSender(), devicePush: getDevicePushSender(), baseUrl };
  const shifts = await sendShiftReminders(db, deliver);
  const contracts = await sendContractReminders(db, deliver);
  const certificates = await sendCertificateReminders(db, deliver);
  return NextResponse.json({ shifts, contracts, certificates });
}

export const GET = run;
export const POST = run;
