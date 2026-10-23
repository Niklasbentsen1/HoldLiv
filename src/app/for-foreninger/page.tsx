import Link from "next/link";
import { SalesFrame } from "../../components/SalesFrame";
import { holdlivPriceText } from "../../lib/priser";

export const metadata = { title: "HoldLiv: ét system til holdene og kassereren", description: "Kalender, kontingent, indmeldelse, hjemmeside og meget mere i ét system. Gratis flytning fra Klubmodul og Holdsport." };
export const dynamic = "force-dynamic";

const POINTS: [string, string][] = [
  ["Både holdet og kassereren", "Trænere får kalender, svar, chat, samkørsel og kampe. Kassereren får kontingent, rykkere, udlæg og medlemstal. I samme system."],
  ["Slå kun til, hvad hvert hold skal bruge", "U9 kan have samkørsel og frugtliste, U15 trænerudlæg og seniorerne bødekasse. Moduler slås til pr. hold."],
  ["Meget er bygget ind", "Hjemmeside, billetsalg, vagtplan, kontrakter, børneattester og booking er bygget ind i systemet."],
  ["Gratis flytning", "Importér medlemmerne fra Klubmodul, Holdsport eller Excel. Du ser resultatet, før noget gemmes."],
  ["Foreningen bestemmer priserne", "Kontingent, camps, billetter og leje sætter foreningen selv. Pengene går direkte til foreningens egen Stripe-konto."],
  ["Tryg for børn og forældre", "Børn har ikke eget login, forældre styrer familien, og hjemmesiden viser aldrig medlemmer."],
];

export default async function Landing() {
  const price = holdlivPriceText();
  return (
    <SalesFrame>
      <section className="stack" style={{ padding: "24px 0" }}>
        <h1>Hele foreningen i ét system</h1>
        <p style={{ fontSize: "1.2em", maxWidth: 640 }}>Kalender og hold til trænerne, kontingent og indmeldelse til kassereren, og en hjemmeside til alle.</p>
        <p className="sales-actions">
          <Link href="/login?next=/opret-forening" className="primary">Opret jeres forening</Link>
          <Link href="/priser">Se pris og sammenligning</Link>
        </p>
        <p className="muted small">{price ? `Pris: ${price}` : "Pris kommer snart."} Foreningen bestemmer selv sine egne priser.</p>
      </section>
      <section>
        <ul className="stack" style={{ listStyle: "none", padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
          {POINTS.map(([t, d]) => (
            <li key={t} className="card"><strong className="block">{t}</strong><span className="muted">{d}</span></li>
          ))}
        </ul>
      </section>
      <section className="card stack">
        <h2>Sådan kommer I i gang</h2>
        <ol>
          <li>Opret foreningen med din e-mail. Du bliver første administrator.</li>
          <li>Importér medlemmerne, eller del holdenes invitationslink.</li>
          <li>Åbn for indmeldelse, og tænd hjemmesiden, når I er klar.</li>
        </ol>
        <p className="muted small">Mangler du hjælp, står der svar i <Link href="/hjaelpecenter">hjælpecenteret</Link>, og du kan skrive til os.</p>
      </section>
    </SalesFrame>
  );
}
