// Telefonens kalenderapp henter aktiviteterne herfra. Linket er hemmeligt og kan nulstilles på /indstillinger.
import { NextResponse, type NextRequest } from "next/server";
import { buildFeed } from "../../../../services";
import { db } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token.replace(/\.ics$/, "");
  const baseUrl = (process.env.APP_URL ?? req.nextUrl.origin).replace(/\/$/, "");
  const body = await buildFeed(db, token, baseUrl);
  if (!body) return new NextResponse("Kalenderlinket findes ikke eller er nulstillet.", { status: 404 });
  return new NextResponse(body, {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "private, no-store", "Content-Disposition": 'inline; filename="holdliv.ics"' },
  });
}
