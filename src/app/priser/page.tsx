import Link from "next/link";
import { SalesFrame } from "../../components/SalesFrame";
import { COMPARISON, COMPETITORS, COMPETITOR_CHECKED, holdlivPriceText, type Mark } from "../../lib/priser";

export const metadata = { title: "Pris og sammenligning · HoldLiv", description: "HoldLivs pris og en sammenligning med Klubmodul og Holdsport, med kilde og dato." };
export const dynamic = "force-dynamic";

// For konkurrenterne betyder "–" kun, at vi ikke har fundet funktionen på deres hjemmeside. For HoldLiv betyder det, at den ikke er bygget.
const SYMBOL: Record<Mark, string> = { ja: "✓ Ja", delvist: "◐ Delvist eller tilkøb", nej: "– Ikke fundet" };
const HOLDLIV_SYMBOL: Record<Mark, string> = { ja: "✓ Ja", delvist: "◐ Delvist", nej: "– Ikke bygget endnu" };

export default async function Prices() {
  const price = holdlivPriceText();
  return (
    <SalesFrame>
      <h1>Pris og sammenligning</h1>
      <section className="card stack">
        <h2>HoldLiv</h2>
        {price ? <p style={{ fontSize: "1.4em" }}><strong>{price}</strong></p> : <p style={{ fontSize: "1.4em" }}><strong>Pris kommer snart</strong></p>}
        <p>Hjemmeside, billetsalg, vagtplan, kontrakter, booking og dataflytning er bygget ind i HoldLiv. Prisen og hvad den dækker, offentliggøres, når den er besluttet.</p>
        <p className="muted small">Foreningens egne priser (kontingent, camps, billetter, leje) sætter foreningen selv. Betalingsudbyderen Stripe tager sit eget gebyr på kortbetalinger.</p>
      </section>

      <section className="stack">
        <h2>Hvad de andre tager</h2>
        <p className="muted small">Læst på udbydernes egne hjemmesider den {COMPETITOR_CHECKED}. Priser ændrer sig, så tjek altid hos udbyderen, før I vælger.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
          {COMPETITORS.map((c) => (
            <div key={c.name} className="card stack">
              <h3>{c.name}</h3>
              <ul>{c.lines.map((l) => <li key={l}>{l}</li>)}</ul>
              <p className="muted small">Kilde: <a href={c.source.url} rel="noopener noreferrer">{c.source.label}</a>, læst {COMPETITOR_CHECKED}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="stack">
        <h2>Funktioner side om side</h2>
        <p className="muted small">Konkurrenternes kolonner er læst på deres hjemmesider den {COMPETITOR_CHECKED} og kan være ændret siden. "Ikke fundet" betyder kun, at vi ikke fandt funktionen på deres hjemmeside, ikke at den ikke findes. HoldLiv-kolonnen viser, hvad der er bygget i dag, også det der mangler.</p>
        <div className="cmp-table">
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>{["Funktion", "Klubmodul", "Holdsport", "HoldLiv"].map((h) => <th key={h} scope="col" style={{ textAlign: "left", padding: 8 }}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {COMPARISON.map((r) => (
                <tr key={r.area} style={{ borderTop: "1px solid var(--line, #ddd)" }}>
                  <th scope="row" style={{ textAlign: "left", padding: 8, fontWeight: 500 }}>{r.area}{r.note && <span className="muted small block">{r.note}</span>}</th>
                  <td style={{ padding: 8 }}>{SYMBOL[r.klubmodul]}</td>
                  <td style={{ padding: 8 }}>{SYMBOL[r.holdsport]}</td>
                  <td style={{ padding: 8 }}><strong>{HOLDLIV_SYMBOL[r.holdliv]}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul className="cmp-cards">
          {COMPARISON.map((r) => (
            <li key={r.area} className="card">
              <strong>{r.area}</strong>
              <span><strong>HoldLiv:</strong> {HOLDLIV_SYMBOL[r.holdliv]}</span>
              <span className="muted">Klubmodul: {SYMBOL[r.klubmodul]}</span>
              <span className="muted">Holdsport: {SYMBOL[r.holdsport]}</span>
              {r.note && <span className="muted small">{r.note}</span>}
            </li>
          ))}
        </ul>
      </section>
      <p><Link href="/login?next=/opret-forening" className="primary">Opret jeres forening</Link></p>
    </SalesFrame>
  );
}
