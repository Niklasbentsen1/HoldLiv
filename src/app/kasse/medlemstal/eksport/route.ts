import { type NextRequest } from "next/server";
import { listFinanceClubs, memberStatsCsv } from "../../../../services";
import { db } from "../../../../lib/db";
import { getSession } from "../../../../lib/session";
import { ForbiddenError } from "../../../../auth/permissions";
import { localDate } from "../../../../lib/money";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return new Response("Log ind først", { status: 401 });
  const clubId = req.nextUrl.searchParams.get("klub") ?? (await listFinanceClubs(db, session.ctx))[0]?.id ?? "";
  const asOf = req.nextUrl.searchParams.get("dato") ?? localDate(new Date());
  try {
    const csv = await memberStatsCsv(db, session.ctx, clubId, asOf, req.nextUrl.searchParams.get("kun") === "aktive" ? "active" : "all");
    return new Response(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="medlemstal-${asOf}.csv"` },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Ingen adgang", { status: 403 });
    if (e instanceof Error && e.message === "Vælg en dato.") return new Response(e.message, { status: 400 });
    throw e;
  }
}
