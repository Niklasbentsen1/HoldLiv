import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicSite } from "../../../services";
import { db } from "../../../lib/db";
import { Crest } from "../../../components/ui";
import { kr } from "../../../lib/money";
import { TYPE_LABEL, dayHeading, time, when as dateTime } from "../../../lib/format";

export const dynamic = "force-dynamic";

const label = (t: string) => (t in TYPE_LABEL ? TYPE_LABEL[t as keyof typeof TYPE_LABEL] : "Aktivitet");
const when = new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Copenhagen" });

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const site = await getPublicSite(db, slug);
  if (!site) return { title: "HoldLiv", robots: { index: false, follow: false } };
  return { title: site.clubName, description: site.intro?.slice(0, 160) ?? `${site.clubName}: hold, kalender og nyheder` };
}

/** Foreningens offentlige hjemmeside. Ingen login, og aldrig personer: kun det foreningen selv har valgt at vise. */
export default async function Site({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const site = await getPublicSite(db, slug);
  if (!site) notFound();

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "24px 16px 64px" }}>
      <header className="card brand stack" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Crest name={site.clubName} size={56} />
          <h1 style={{ margin: 0 }}>{site.clubName}</h1>
        </div>
        {site.intro && <p className="chat-text" style={{ margin: 0 }}>{site.intro}</p>}
        {site.signupOpen && (
          <div>
            <Link href={`/tilmeld/${site.slug}`} className="button">Meld dig ind</Link>
          </div>
        )}
      </header>

      {site.news.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h2 className="section-head">Nyheder</h2>
          {site.news.map((n) => (
            <article key={n.id} className="card stack" style={{ marginBottom: 12 }}>
              <h3 style={{ margin: 0 }}>{n.title}</h3>
              <span className="muted small">{when.format(n.createdAt)}</span>
              <p className="chat-text" style={{ margin: 0 }}>{n.body}</p>
            </article>
          ))}
        </section>
      )}

      {site.tickets.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h2 className="section-head">Billetter</h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {site.tickets.map((t) => (
              <li key={t.id} className="card" style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ flex: 1 }}>
                  <strong className="block">{t.name}</strong>
                  <span className="muted small">
                    {dateTime(t.startsAt)}
                    {t.location ? ` · ${t.location}` : ""}
                  </span>
                </span>
                <span>{t.priceOre === 0 ? "Gratis" : kr(t.priceOre)}</span>
                {t.soldOut ? <span className="pill cancel">Udsolgt</span> : <Link href={`/billetter/${t.id}`} className="button">Køb billetter</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {site.days && (
        <section style={{ marginBottom: 24 }}>
          <h2 className="section-head">Kommende aktiviteter</h2>
          {site.days.length === 0 && <p className="muted">Der er ingen aktiviteter de næste 30 dage.</p>}
          {site.days.map((d) => (
            <div key={d.date} style={{ marginBottom: 14 }}>
              <h3 style={{ margin: "0 0 6px" }}>{dayHeading(d.events[0].startsAt)}</h3>
              <ul className="events" style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                {d.events.map((e) => (
                  <li key={e.id} className="card" style={{ display: "flex", gap: 14, flexWrap: "wrap", opacity: e.cancelled ? 0.6 : 1 }}>
                    <strong style={{ minWidth: 110 }}>
                      {time(e.startsAt)}
                      {e.endsAt ? `–${time(e.endsAt)}` : ""}
                    </strong>
                    <span style={{ flex: 1, textDecoration: e.cancelled ? "line-through" : "none" }}>
                      {e.team}: {e.title} <span className="muted">({label(e.type)})</span>
                    </span>
                    <span className="muted">{e.cancelled ? "Aflyst" : e.location}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {site.teams && site.teams.length > 0 && (
        <section style={{ marginBottom: 24 }}>
          <h2 className="section-head">Vores hold</h2>
          <ul className="team-grid">
            {site.teams.map((t) => (
              <li key={t.id} className="card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Crest name={t.name} size={40} />
                <span>
                  <strong className="block">{t.name}</strong>
                  {t.season && <span className="muted small">{t.season}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {site.contact && (
        <section className="card stack">
          <h2 className="section-head">Kontakt</h2>
          <p className="chat-text" style={{ margin: 0 }}>{site.contact}</p>
        </section>
      )}
      <p className="muted small" style={{ marginTop: 24 }}>Hjemmesiden drives af HoldLiv.</p>
    </main>
  );
}
