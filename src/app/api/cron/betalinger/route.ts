// Køres af en planlagt opgave (fx hvert kvarter) med "Authorization: Bearer $CRON_SECRET".
// Trækker forfaldne opkrævninger fra gemte kort (kun betalere, der selv har sagt ja). Kan køres så ofte, man vil: en opkrævning prøves højst én gang i døgnet.
import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runAutoCharges } from "../../../../services";
import { getPaymentProvider } from "../../../../lib/payments";
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
  const result = await runAutoCharges(db, getPaymentProvider(), { mail: sendMail, sms: getSmsSender(), push: getPushSender(), devicePush: getDevicePushSender(), baseUrl });
  return NextResponse.json(result);
}

export const GET = run;
export const POST = run;
