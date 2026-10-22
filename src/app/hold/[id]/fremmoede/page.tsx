import Link from "next/link";
import { getAttendanceOverview, getTeam } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { tinyDate, TYPE_LABEL } from "../../../../lib/format";
import { Shell } from "../../../../components/Shell";
import { Avatar, PageHead, Ring, Stat } from "../../../../components/ui";

export const dynamic = "force-dynamic";
const MARK = { yes: "✓", maybe: "?", no: "✕" } as const;

export default async function Attendance({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ uger?: string }> }) {
  const { id } = await params;
  const weeks = Math.min(52, Math.max(1, Number((await searchParams).uger) || 4));
  const { ctx } = await requireSession(`/hold/${id}/fremmoede`);
  const team = await getTeam(db, ctx, id);
  const from = new Date(ctx.now.getTime() - weeks * 7 * 86_400_000);
  const to = new Date(ctx.now.getTime() + 14 * 86_400_000);
  const o = await getAttendanceOverview(db, ctx, id, from, to);

  const rates = o.players.map((p) => p.rate).filter((r): r is number => r !== null);
  const avg = rates.length ? Math.round(rates.reduce((a, b) => a + b, 0) / rates.length) : null;
  const missing = o.players.filter((p) => p.unanswered > 0);
  const held = o.events.filter((e) => e.past).length;

  return (
    <Shell admin={ctx.adminClubs.size > 0}>
      <PageHead
        back={{ href: `/hold/${id}`, label: team.name }}
        title="Fremmøde"
        sub={`De seneste ${weeks} uger og de næste 2. Procent er andelen af afholdte aktiviteter, hvor spilleren kom.`}
        actions={
          <nav className="seg" aria-label="Periode">
            {[4, 8, 12].map((w) => (
              <Link key={w} href={`?uger=${w}`} className={w === weeks ? "on" : undefined}>
                {w} uger
              </Link>
            ))}
          </nav>
        }
      />

      <div className="tiles" style={{ marginBottom: 20 }}>
        <Stat label="Gennemsnit" tone="brand" value={<Ring value={avg} size={92} stroke={10} />} icon="chart" hint={<span style={{ color: "var(--on-feature-muted)" }}>Fremmøde pr. spiller</span>} />
        <Stat label="Afholdt" value={held} icon="whistle" hint="aktiviteter i perioden" />
        <Stat label="Mangler svar" value={missing.length} tone={missing.length ? "tint" : undefined} icon="bell" hint="spillere, på kommende aktiviteter" />
      </div>

      <div className="card matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th className="name">Spiller</th>
              <th className="rate-cell">%</th>
              {o.events.map((e) => (
                <th key={e.id} className={e.past ? "past" : "future"} title={`${TYPE_LABEL[e.type]}: ${e.title}`}>
                  <Link href={`/aktivitet/${e.id}`}>
                    {tinyDate(e.startsAt)}
                    <span className={`dot ${e.type}`} />
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {o.players.map((p) => {
              const tone = p.rate === null ? "" : p.rate >= 75 ? "good" : p.rate >= 50 ? "mid" : "low";
              return (
                <tr key={p.profileId}>
                  <td className="name">
                    <span>
                      <Avatar name={`${p.firstName} ${p.lastName}`} size={28} />
                      {p.firstName} {p.lastName.charAt(0)}.
                    </span>
                  </td>
                  <td className="rate-cell">
                    <span className={`rate ${tone}`}>
                      {p.rate === null ? "–" : p.rate}
                      {p.rate !== null && (
                        <b>
                          <i style={{ width: `${p.rate}%` }} />
                        </b>
                      )}
                    </span>
                  </td>
                  {p.cells.map((c, i) => (
                    <td key={o.events[i].id} className={`cell ${c ?? "none"} ${o.events[i].past ? "past" : "future"}`}>
                      <i>{c ? MARK[c] : ""}</i>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="legend">
        <span><i className="yes" />Kom/kommer</span>
        <span><i className="maybe" />Måske</span>
        <span><i className="no" />Meldt fra</span>
        <span><i className="none" />Ikke svaret</span>
        <span><i style={{ background: "var(--training)" }} />Træning</span>
        <span><i style={{ background: "var(--match)" }} />Kamp</span>
        <span>Aflyste aktiviteter er ikke med.</span>
      </p>

      <section className="section">
        <div className="section-head">
          <h2>Mangler svar på kommende</h2>
        </div>
        <ul className="people">
          {missing.map((p) => (
            <li key={p.profileId}>
              <Avatar name={`${p.firstName} ${p.lastName}`} />
              <span className="name grow">
                {p.firstName} {p.lastName}
              </span>
              <span className="pill">{p.unanswered} mangler</span>
            </li>
          ))}
          {missing.length === 0 && <li className="muted">Alle har svaret.</li>}
        </ul>
      </section>
    </Shell>
  );
}
