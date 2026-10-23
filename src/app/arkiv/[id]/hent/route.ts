import { type NextRequest } from "next/server";
import { getDocumentFile } from "../../../../services";
import { db } from "../../../../lib/db";
import { getSession } from "../../../../lib/session";
import { ForbiddenError } from "../../../../auth/permissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Et dokument fra arkivet som download. Kun dem, dokumentets målgruppe omfatter. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return new Response("Log ind først", { status: 401 });
  if (!UUID.test(id)) return new Response("Ikke fundet", { status: 404 });
  try {
    const f = await getDocumentFile(db, session.ctx, id);
    return new Response(new Uint8Array(f.data), {
      headers: {
        "Content-Type": f.contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.fileName)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Ingen adgang", { status: 403 });
    if (e instanceof Error && e.message === "Dokumentet findes ikke.") return new Response("Ikke fundet", { status: 404 });
    throw e;
  }
}
