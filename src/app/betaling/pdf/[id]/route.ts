import { type NextRequest } from "next/server";
import { getReceipt } from "../../../../services";
import { db } from "../../../../lib/db";
import { getSession } from "../../../../lib/session";
import { ForbiddenError } from "../../../../auth/permissions";
import { kr, longDate } from "../../../../lib/money";
import { simplePdf } from "../../../../lib/pdf";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return new Response("Log ind først", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Findes ikke", { status: 404 });
  try {
    const r = await getReceipt(db, session.ctx, id);
    const pdf = simplePdf([
      { text: r.clubName, size: 20, bold: true },
      { text: `Kvittering nr. ${r.number}`, size: 12, gap: 6 },
      { text: `Dato: ${longDate(r.paidOn)}`, gap: 24 },
      { text: "Betaling for", bold: true, gap: 12 },
      { text: r.payerName },
      { text: r.description },
      { text: "Beløb", bold: true, gap: 12 },
      { text: kr(r.amountOre), size: 14 },
      { text: "Betalt", bold: true, gap: 12 },
      { text: `${longDate(r.paidOn)}, ${r.method}` },
      { text: `Kvitteringen er udstedt af ${r.clubName} via HoldLiv.`, size: 9, gap: 40 },
    ]);
    return new Response(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="kvittering-${r.number}.pdf"` },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return new Response("Ingen adgang", { status: 403 });
    if (e instanceof Error && e.message.startsWith("Der er ikke betalt")) return new Response(e.message, { status: 409 });
    if (e instanceof Error && e.message.includes("findes ikke")) return new Response("Findes ikke", { status: 404 });
    throw e;
  }
}
