import { NextResponse } from "next/server";
import { db } from "../../../../lib/db";
import { getSession } from "../../../../lib/session";
import { exportMyData } from "../../../../services";

export const dynamic = "force-dynamic";

/** Alle ens egne data som JSON-fil. */
export async function GET() {
  const session = await getSession();
  if (!session) return new NextResponse("Log ind først.", { status: 401 });
  const data = await exportMyData(db, session.ctx);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="mine-data-holdliv.json"',
      "cache-control": "no-store",
    },
  });
}
