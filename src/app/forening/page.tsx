import Link from "next/link";
import { listAdminClubs, listTreasurers } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { Shell, ErrorBox } from "../../components/Shell";
import { addTreasurer, newTeam, removeTreasurer } from "../actions";

export const dynamic = "force-dynamic";

export default async function Club({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx } = await requireSession("/forening");
  const clubs = await Promise.all(
    (await listAdminClubs(db, ctx)).map(async (c) => ({ ...c, treasurers: await listTreasurers(db, ctx, c.id) })),
  );
  if (clubs.length === 0) return <Shell ctx={ctx}>Kun foreningens administratorer har adgang her.</Shell>;

  return (
    <Shell active="/forening" ctx={ctx}>
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
          <h2>Kasserer</h2>
          {c.treasurers.length > 0 ? (
            <ul className="people">
              {c.treasurers.map((t) => (
                <li key={t.profileId} className="spread">
                  <span className="grow">
                    {t.firstName} {t.lastName}
                  </span>
                  <form action={removeTreasurer}>
                    <input type="hidden" name="clubId" value={c.id} />
                    <input type="hidden" name="profileId" value={t.profileId} />
                    <button className="mini">Fjern</button>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Ingen kasserer endnu. Administratorer kan selv håndtere kontingent under Kasse.</p>
          )}
          <form action={addTreasurer} className="inline">
            <input type="hidden" name="clubId" value={c.id} />
            <input type="email" name="email" required placeholder="Kassererens e-mail" />
            <button>Tilføj</button>
          </form>
          <p className="muted small">Kassereren får adgang til medlemmer, kontingent og betalinger, men ikke til hold og trænere.</p>
        </section>
      ))}
    </Shell>
  );
}
