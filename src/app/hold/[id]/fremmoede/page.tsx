import Link from "next/link";
import { getAttendanceOverview, getTeam } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { tinyDate, TYPE_LABEL } from "../../../../lib/format";
import { Shell } from "../../../../components/Shell";

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

  return (
    <Shell ctx={ctx}>
      <Link href={`/hold/${id}`} className="muted small">
        ← {team.name}
      </Link>
      <h1>Fremmøde</h1>
      <p className="muted small">
        De seneste{" "}
        {[4, 8, 12].map((w, i) => (
          <span key={w}>
            {i > 0 && " / "}
            {w === weeks ? <strong>{w}</strong> : <Link href={`?uger=${w}`}>{w}</Link>}
          </span>
        ))}{" "}
        uger og de næste 2. Procent er andelen af afholdte aktiviteter, hvor spilleren kom.
      </p>

      <div className="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th className="name">Spiller</th>
              <th>%</th>
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
            {o.players.map((p) => (
              <tr key={p.profileId}>
                <td className="name">
                  {p.firstName} {p.lastName.charAt(0)}.
                </td>
                <td className={`rate ${p.rate === null ? "" : p.rate >= 75 ? "good" : p.rate >= 50 ? "mid" : "low"}`}>
                  {p.rate === null ? "–" : `${p.rate}`}
                </td>
                {p.cells.map((c, i) => (
                  <td key={o.events[i].id} className={`cell ${c ?? "none"} ${o.events[i].past ? "past" : "future"}`}>
                    {c ? MARK[c] : ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small legend">
        ✓ kom/kommer · ? måske · ✕ meldt fra · tom: ikke svaret. Prik: grøn træning, orange kamp. Aflyste aktiviteter er ikke med.
      </p>

      <h2>Mangler svar på kommende</h2>
      <ul className="people">
        {o.players
          .filter((p) => p.unanswered > 0)
          .map((p) => (
            <li key={p.profileId}>
              {p.firstName} {p.lastName} <span className="muted">· {p.unanswered}</span>
            </li>
          ))}
        {o.players.every((p) => p.unanswered === 0) && <li className="muted">Alle har svaret.</li>}
      </ul>
    </Shell>
  );
}
