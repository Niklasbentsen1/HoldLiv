import Link from "next/link";
import { listAdminClubs } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { Shell, ErrorBox } from "../../components/Shell";
import { newTeam } from "../actions";

export const dynamic = "force-dynamic";

export default async function Club({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx } = await requireSession("/forening");
  const clubs = await listAdminClubs(db, ctx);
  if (clubs.length === 0) return <Shell>Kun foreningens administratorer har adgang her.</Shell>;

  return (
    <Shell active="/forening" admin>
      <ErrorBox message={fejl} />
      {clubs.map((c) => (
        <section key={c.id}>
          <h1>{c.name}</h1>
          <h2>Hold</h2>
          <ul className="teams">
            {c.teams.map((t) => (
              <li key={t.id}>
                <Link href={`/hold/${t.id}`} className="card team-link">
                  <strong>{t.name}</strong>
                  <span className="muted small">{t.season}</span>
                  <span className="labels">{t.coaches.length ? `Træner: ${t.coaches.join(", ")}` : "Mangler træner"}</span>
                </Link>
              </li>
            ))}
          </ul>
          <details className="card">
            <summary>Opret hold</summary>
            <form action={newTeam} className="stack">
              <input type="hidden" name="clubId" value={c.id} />
              <div className="row">
                <label>
                  Navn
                  <input name="name" required placeholder="Fx U10 piger" />
                </label>
                <label>
                  Sæson
                  <input name="season" placeholder="2026/27" />
                </label>
              </div>
              <button className="primary">Opret hold</button>
            </form>
            <p className="muted small">Træneren tilføjes bagefter på holdets side.</p>
          </details>
        </section>
      ))}
    </Shell>
  );
}
