import { type NextRequest } from "next/server";
import { getExpenseReceipt } from "../../../../services";
import { db } from "../../../../lib/db";
import { getSession } from "../../../../lib/session";
import { ForbiddenError } from "../../../../auth/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kvitteringen til et udlæg. Kun den, der har indsendt kravet, og foreningens admin/kasserer. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return new Response("Log ind først", { status: 401 });
  if (!UUID.test(id)) return new Response("Ikke fundet", { status: 404 });
  try {
    const r = await getExpenseReceipt(db, session.ctx, id);
    return new Response(new Uint8Array(r.data), {
      headers: {
        "Content-Type": r.contentType,
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        // Selv hvis en fil skulle indeholde aktivt indhold, må den ikke køre noget.
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Ingen adgang", { status: 403 });
    if (e instanceof Error && (e.message === "Kravet findes ikke" || e.message === "Kravet har ingen kvittering")) return new Response("Ikke fundet", { status: 404 });
    throw e;
  }
}
