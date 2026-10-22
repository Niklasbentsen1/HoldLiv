import { type NextRequest } from "next/server";
import { expensesCsv, listFinanceClubs } from "../../../../services";
import { db } from "../../../../lib/db";
import { getSession } from "../../../../lib/session";
import { ForbiddenError } from "../../../../auth/permissions";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return new Response("Log ind først", { status: 401 });
  const clubId = req.nextUrl.searchParams.get("klub") ?? (await listFinanceClubs(db, session.ctx))[0]?.id ?? "";
  try {
    const csv = await expensesCsv(db, session.ctx, clubId);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="udlaeg-til-udbetaling-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Ingen adgang", { status: 403 });
    throw e;
  }
}
