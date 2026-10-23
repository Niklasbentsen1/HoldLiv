import Link from "next/link";
import { AUDIENCES, searchArticles, type Audience } from "../../lib/hjaelpeartikler";
import { HelpFrame } from "../../components/HelpFrame";
import { PageHead } from "../../components/ui";

export const metadata = { title: "Hjælpecenter · HoldLiv" };
export const dynamic = "force-dynamic";

export default async function HelpCenter({ searchParams }: { searchParams: Promise<{ q?: string; for?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 100);
  const audience = sp.for && sp.for in AUDIENCES ? (sp.for as Audience) : undefined;
  const hits = searchArticles(q, audience);
  return (
    <HelpFrame>
      <PageHead title="Hjælpecenter" sub="Svar til foreningens administratorer, kasserere, trænere og forældre." />
      <form method="get" className="row" role="search" style={{ gap: 8 }}>
        <input name="q" defaultValue={q} placeholder="Søg, fx import, kontingent eller log ind" aria-label="Søg i hjælpen" className="grow" />
        {audience && <input type="hidden" name="for" value={audience} />}
        <button className="primary">Søg</button>
      </form>
      <p className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <Link href={q ? `/hjaelpecenter?q=${encodeURIComponent(q)}` : "/hjaelpecenter"} className={audience ? "muted small" : "small"}>Alle</Link>
        {(Object.entries(AUDIENCES) as [Audience, string][]).map(([k, label]) => (
          <Link key={k} href={`/hjaelpecenter?for=${k}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className={audience === k ? "small" : "muted small"}>{label}</Link>
        ))}
      </p>
      {hits.length === 0 ? (
        <p className="muted">Ingen artikler matcher "{q}". Prøv et andet ord, eller <Link href="/hjaelpecenter/kontakt">skriv til HoldLiv</Link>.</p>
      ) : (
        <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
          {hits.map((a) => (
            <li key={a.slug} className="card">
              <Link href={`/hjaelpecenter/${a.slug}`}><strong>{a.title}</strong></Link>
              <span className="muted small block">{a.summary}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Er du medlem og har et spørgsmål om dine egne aktiviteter eller betalinger, kan du spørge <Link href="/hjaelp">AI-hjælpen</Link>, hvis foreningen har slået den til.
        Finder du ikke svar, kan du <Link href="/hjaelpecenter/kontakt">skrive til HoldLiv-support</Link>.
      </p>
    </HelpFrame>
  );
}
