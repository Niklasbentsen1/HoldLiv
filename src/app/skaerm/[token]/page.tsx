import { notFound } from "next/navigation";
import { getScreenView } from "../../../services";
import { db } from "../../../lib/db";
import { AutoRefresh } from "../../../components/AutoRefresh";
import { TYPE_LABEL, dayHeading, time } from "../../../lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Infoskærm", robots: { index: false, follow: false } };

const label = (t: string) => (t in TYPE_LABEL ? TYPE_LABEL[t as keyof typeof TYPE_LABEL] : "Aktivitet");

/** Siden til en skærm i klubhuset. Ingen login: linket er hemmeligt, og siden viser kun titler, tider, steder og foreningens nyheder. */
export default async function Screen({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await getScreenView(db, token);
  if (!view) notFound();

  return (
    <main className="info-screen" style={{ minHeight: "100vh", background: "#17181d", color: "#fff", padding: "32px 48px", fontSize: 22 }}>
      <AutoRefresh seconds={60} />
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 44, color: "#fff" }}>{view.clubName}</h1>
        <span style={{ opacity: 0.7 }}>{dayHeading(new Date())}</span>
      </header>
      {view.message && (
        <p style={{ background: "var(--brand)", borderRadius: 16, padding: "16px 24px", fontSize: 28, margin: "0 0 24px" }}>{view.message}</p>
      )}
      <div style={{ display: "grid", gridTemplateColumns: view.news.length ? "2fr 1fr" : "1fr", gap: 32 }}>
        <section>
          {view.days.length === 0 && <p style={{ opacity: 0.7 }}>Ingen aktiviteter de næste dage.</p>}
          {view.days.map((d) => (
            <div key={d.date} style={{ marginBottom: 24 }}>
              <h2 style={{ margin: "0 0 8px", fontSize: 28, color: "var(--brand-2)" }}>{d.date === view.today ? "I dag" : dayHeading(d.events[0].startsAt)}</h2>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                {d.events.map((e) => (
                  <li key={e.id} style={{ display: "flex", gap: 20, background: "#23252d", borderRadius: 14, padding: "12px 20px", opacity: e.cancelled ? 0.5 : 1 }}>
                    <strong style={{ minWidth: 150 }}>
                      {time(e.startsAt)}
                      {e.endsAt ? `–${time(e.endsAt)}` : ""}
                    </strong>
                    <span style={{ flex: 1, textDecoration: e.cancelled ? "line-through" : "none" }}>
                      {e.team}: {e.title} <span style={{ opacity: 0.6 }}>({label(e.type)})</span>
                    </span>
                    <span style={{ opacity: 0.8 }}>{e.cancelled ? "Aflyst" : e.location}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
        {view.news.length > 0 && (
          <aside>
            <h2 style={{ margin: "0 0 8px", fontSize: 28, color: "var(--brand-2)" }}>Nyheder</h2>
            {view.news.map((n) => (
              <article key={n.id} style={{ background: "#23252d", borderRadius: 14, padding: "16px 20px", marginBottom: 12 }}>
                <strong style={{ display: "block", fontSize: 24 }}>{n.title}</strong>
                <p style={{ margin: "8px 0 0", opacity: 0.85, whiteSpace: "pre-wrap" }}>{n.body}</p>
              </article>
            ))}
          </aside>
        )}
      </div>
    </main>
  );
}
