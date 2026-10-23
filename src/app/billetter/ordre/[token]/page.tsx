import QRCode from "qrcode";
import { notFound } from "next/navigation";
import { getTicketOrder } from "../../../../services";
import { db } from "../../../../lib/db";
import { origin } from "../../../../lib/origin";
import { kr } from "../../../../lib/money";
import { when } from "../../../../lib/format";
import { AutoRefresh } from "../../../../components/AutoRefresh";
import { Bare } from "../../../../components/Shell";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dine billetter", robots: { index: false, follow: false } };

/** Køberens billetter med QR-koder. Kun den, der har det hemmelige link, kan se siden. */
export default async function Order({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const order = await getTicketOrder(db, token);
  if (!order) notFound();
  const base = await origin();
  const svgs = await Promise.all(order.tickets.map((t) => QRCode.toString(`${base}/billet/${t.code}`, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#17181d", light: "#ffffff" } })));

  return (
    <Bare>
      <section className="card stack">
        <span className="muted small">{order.event.clubName}</span>
        <h1 className="flush">{order.event.name}</h1>
        <span>
          {when(order.event.startsAt)}
          {order.event.location ? ` · ${order.event.location}` : ""}
        </span>
        <span className="muted small">
          {order.quantity} billet{order.quantity === 1 ? "" : "ter"} til {order.buyerName}
          {order.amountOre > 0 ? ` · ${kr(order.amountOre)}` : ""}
        </span>
        {order.event.cancelled && <p className="error">Arrangementet er aflyst. Foreningen refunderer dit køb.</p>}
        {order.status === "pending" && (
          <>
            <AutoRefresh seconds={5} />
            <p>Vi venter på bekræftelse af betalingen. Siden opdaterer sig selv.</p>
          </>
        )}
        {order.status === "cancelled" && <p className="error">Bestillingen er annulleret. Er der trukket penge, så kontakt foreningen.</p>}
        {order.status === "refunded" && <p className="error">Købet er refunderet, og billetterne er ikke længere gyldige.</p>}
      </section>
      {order.status === "paid" &&
        order.tickets.map((t, i) => (
          <section key={t.code} className="card stack" style={{ maxWidth: 320, opacity: t.used || t.voided ? 0.5 : 1 }}>
            <strong>
              Billet {i + 1} af {order.tickets.length}
            </strong>
            <div role="img" aria-label={`QR-kode til billet ${i + 1}`} style={{ width: 240, height: 240, alignSelf: "center" }} dangerouslySetInnerHTML={{ __html: svgs[i] }} />
            <span className={t.used || t.voided ? "pill cancel" : "pill brand"} style={{ alignSelf: "flex-start" }}>
              {t.voided ? "Ikke gyldig" : t.used ? "Brugt" : "Gyldig"}
            </span>
          </section>
        ))}
      <p className="muted small">Gem linket til siden, eller find det i mailen. Vis en billet ad gangen ved indgangen. Del ikke billetterne med andre.</p>
    </Bare>
  );
}
