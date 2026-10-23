import Link from "next/link";
import { listAdminClubs, listTreasurers, moduleMatrix } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { Shell, ErrorBox } from "../../components/Shell";
import { Avatar, Crest, Icon, PageHead } from "../../components/ui";
import { addTreasurer, aiServiceSettingAction, newTeam, removeTreasurer, saveModuleMatrix } from "../actions";

export const dynamic = "force-dynamic";

export default async function Club({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx } = await requireSession("/forening");
  const clubs = await Promise.all(
    (await listAdminClubs(db, ctx)).map(async (c) => ({ ...c, treasurers: await listTreasurers(db, ctx, c.id), matrix: await moduleMatrix(db, ctx, c.id) })),
  );
  if (clubs.length === 0) return <Shell ctx={ctx}>Kun foreningens administratorer har adgang her.</Shell>;

  return (
    <Shell active="/forening" ctx={ctx}>
      <ErrorBox message={fejl} />
      {clubs.map((c) => (
        <section key={c.id}>
          <PageHead kicker={<><Crest name={c.name} size={22} /> Forening</>} title={c.name} sub={`${c.teams.length} hold`} />
          <p className="row" style={{ gap: 16 }}>
            <Link href={`/forening/forslag?klub=${c.id}`} className="muted small">Holdforslag</Link>
            <Link href={`/forening/import?klub=${c.id}`} className="muted small">Importér medlemmer</Link>
            <Link href={`/forening/tilmeldinger?klub=${c.id}`} className="muted small">Indmeldelse</Link>
            <Link href={`/forening/kontrakter?klub=${c.id}`} className="muted small">Kontrakter</Link>
            <Link href={`/forening/attester?klub=${c.id}`} className="muted small">Børneattester</Link>
            <Link href={`/forening/skaerme?klub=${c.id}`} className="muted small">Infoskærme</Link>
            <Link href={`/forening/log?klub=${c.id}`} className="muted small">Se aktivitetslog</Link>
          </p>
          <ul className="team-grid">
            {c.teams.map((t) => (
              <li key={t.id}>
                <Link href={`/hold/${t.id}`} className="card team-card">
                  <Crest name={t.name} size={44} />
                  <span className="grow">
                    <strong className="block">{t.name}</strong>
                    <span className="labels">{t.season}</span>
                    <span className={t.coaches.length ? "labels block" : "labels block cancelled-note"}>
                      {t.coaches.length ? `Træner: ${t.coaches.join(", ")}` : "Mangler træner"}
                    </span>
                  </span>
                  <span className="go">
                    <Icon name="arrow" size={16} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <details className="card" style={{ marginTop: 16, maxWidth: 560 }}>
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

          <section className="section">
            <div className="section-head">
              <h2>Moduler</h2>
            </div>
            <p className="muted small" style={{ marginBottom: 10 }}>
              Vælg hvilke hold der bruger hvilke moduler. Hvert hold får kun de moduler, I slår til.
            </p>
            {c.matrix.teams.length > 0 && (
              <form action={saveModuleMatrix} className="stack">
                <input type="hidden" name="clubId" value={c.id} />
                {c.matrix.modules.map((m) => (
                  <input key={m.key} type="hidden" name="module" value={m.key} disabled={!m.available} />
                ))}
                {c.matrix.teams.map((t) => (
                  <input key={t.id} type="hidden" name="team" value={t.id} />
                ))}
                <div className="card matrix-wrap">
                  <table className="matrix">
                    <thead>
                      <tr>
                        <th className="name">Hold</th>
                        {c.matrix.modules.map((m) => (
                          <th key={m.key} title={m.description}>
                            {m.name}
                            {!m.available && <span className="muted small block">Kommer snart</span>}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {c.matrix.teams.map((t) => (
                        <tr key={t.id}>
                          <th className="name">{t.name}</th>
                          {c.matrix.modules.map((m) => (
                            <td key={m.key}>
                              <input
                                type="checkbox"
                                name={`on_${m.key}`}
                                value={t.id}
                                defaultChecked={t.enabled[m.key]}
                                disabled={!m.available}
                                aria-label={`${m.name} til ${t.name}`}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <button className="primary">Gem moduler</button>
                </div>
              </form>
            )}
          </section>

          <section className="section" style={{ maxWidth: 560 }}>
            <div className="section-head">
              <h2>AI-hjælp til medlemmer</h2>
            </div>
            <p className="muted small" style={{ marginBottom: 10 }}>
              Medlemmer kan stille spørgsmål om deres egne aktiviteter og betalinger. Svaret bygger kun på deres egne oplysninger, der sendes uden navne, og de skal selv give samtykke. Tjenesten er {c.aiServiceEnabled ? "slået til" : "slået fra"}.
            </p>
            <form action={aiServiceSettingAction}>
              <input type="hidden" name="clubId" value={c.id} />
              <input type="hidden" name="enabled" value={c.aiServiceEnabled ? "0" : "1"} />
              <button>{c.aiServiceEnabled ? "Slå fra" : "Slå til"}</button>
            </form>
          </section>

          <section className="section" style={{ maxWidth: 560 }}>
            <div className="section-head">
              <h2>Kasserer</h2>
            </div>
            {c.treasurers.length > 0 ? (
              <ul className="people">
                {c.treasurers.map((t) => (
                  <li key={t.profileId}>
                    <Avatar name={`${t.firstName} ${t.lastName}`} />
                    <span className="name grow">
                      {t.firstName} {t.lastName}
                    </span>
                    <form action={removeTreasurer}>
                      <input type="hidden" name="clubId" value={c.id} />
                      <input type="hidden" name="profileId" value={t.profileId} />
                      <button className="link small">Fjern</button>
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
            <p className="muted small" style={{ marginTop: 6 }}>Kassereren får adgang til medlemmer, kontingent og betalinger, men ikke til hold og trænere.</p>
          </section>
        </section>
      ))}
    </Shell>
  );
}
