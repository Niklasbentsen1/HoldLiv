import QRCode from "qrcode";
import { listMyCards } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { origin } from "../../lib/origin";
import { ErrorBox, Shell } from "../../components/Shell";
import { Empty, PageHead } from "../../components/ui";
import { shortDay } from "../../lib/format";
import { resetCardAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function Cards({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx } = await requireSession("/medlemskort");
  const [cards, base] = await Promise.all([listMyCards(db, ctx), origin()]);
  const svgs = await Promise.all(cards.map((c) => QRCode.toString(`${base}/tjek/${c.token}`, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#17181d", light: "#ffffff" } })));

  return (
    <Shell ctx={ctx} active="/medlemskort">
      <PageHead title="Medlemskort" sub="Vis kortet til træneren eller i receptionen. Den, der scanner, ser navn, hold og om medlemskabet er gyldigt. Vis kun kortet til en træner eller en administrator." />
      <ErrorBox message={fejl} />
      {cards.length === 0 && <Empty icon="card">Du eller dine børn er ikke aktive medlemmer af en forening endnu.</Empty>}
      <ul className="events">
        {cards.map((c, i) => (
          <li key={`${c.clubId}-${c.profileId}`} className="card stack" style={{ maxWidth: 380 }}>
            <span className="muted small">{c.clubName}</span>
            <strong style={{ fontSize: 24 }}>{c.name}</strong>
            <span className="muted small">
              Medlem siden {shortDay(c.joinedAt)}
              {c.teams.length ? ` · ${c.teams.join(", ")}` : ""}
            </span>
            <div role="img" aria-label={`QR-kode til ${c.name}s medlemskort`} style={{ width: 220, height: 220, alignSelf: "center" }} dangerouslySetInnerHTML={{ __html: svgs[i] }} />
            <details>
              <summary className="small">Mistet telefonen?</summary>
              <form action={resetCardAction} className="stack">
                <input type="hidden" name="clubId" value={c.clubId} />
                <input type="hidden" name="profileId" value={c.profileId} />
                <p className="muted small">Nulstil kortet, så det gamle kort holder op med at virke. Det nye kort vises her med det samme.</p>
                <button className="link small">Nulstil kortet</button>
              </form>
            </details>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
