import { getFineBox, getTeam } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { kr } from "../../../../lib/money";
import { shortDay } from "../../../../lib/format";
import { Shell, ErrorBox } from "../../../../components/Shell";
import { Avatar, Empty, PageHead, Stat } from "../../../../components/ui";
import {
  archiveFineTypeAction,
  cancelFineAction,
  createFineTypeAction,
  giveFineAction,
  payFineAction,
  updateFineTypeAction,
} from "../../../actions";

export const dynamic = "force-dynamic";

const krInput = (ore: number) => String(ore / 100).replace(".", ",");

export default async function Fines({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { id } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/hold/${id}/bodekasse`);
  const team = await getTeam(db, ctx, id);
  const f = await getFineBox(db, ctx, id);
  const activeTypes = f.types.filter((t) => !t.archived);
  const eligible = f.players.filter((p) => p.eligible);
  const tooYoung = f.players.filter((p) => !p.eligible);
  const hidden = <T extends Record<string, string>>(extra: T) => (
    <>
      <input type="hidden" name="teamId" value={id} />
      {Object.entries(extra).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );

  return (
    <Shell ctx={ctx}>
      <PageHead
        back={{ href: `/hold/${id}`, label: team.name }}
        title="Bødekasse"
        sub={`Holdets egen bødekasse. Man kan få en bøde fra ${f.minAge} år. Satserne bestemmer holdet selv.`}
      />
      <ErrorBox message={fejl} />

      <div className="tiles" style={{ marginBottom: 20 }}>
        <Stat label="I kassen" value={kr(f.box.paidOre)} icon="star" hint="betalte bøder" />
        <Stat label="Mangler at blive betalt" value={kr(f.box.openOre)} icon="clock" hint={`${f.box.count} ${f.box.count === 1 ? "bøde" : "bøder"} i alt${f.box.refundedOre ? ` · ${kr(f.box.refundedOre)} tilbagebetalt` : ""}`} />
        <Stat label="Dine bøder" value={f.mine.filter((m) => !m.paid).length} icon="users" hint={f.mine.length ? "ikke betalt" : "ingen"} />
      </div>

      <div className="team-layout">
        <div className="dash-main">
          <section className="section">
            <div className="section-head">
              <h2>Bøder til jer</h2>
            </div>
            {f.mine.length === 0 && <Empty icon="star">Ingen bøder.</Empty>}
            <ul className="people">
              {f.mine.map((m) => (
                <li key={m.id}>
                  <Avatar name={m.playerName} />
                  <span className="grow">
                    <span className="name">{m.description}</span>
                    <span className="note">
                      {m.playerName} · {shortDay(m.createdAt)}
                      {m.eventTitle ? ` · ${m.eventTitle}` : ""}
                    </span>
                  </span>
                  <span className={m.paid ? "pill brand" : "pill cancel"}>
                    {kr(m.amountOre)} · {m.paid ? "betalt" : "ikke betalt"}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {f.canManage && (
            <section className="section">
              <div className="section-head">
                <h2>Spillere</h2>
              </div>
              <ul className="people">
                {f.players.map((p) => (
                  <li key={p.profileId}>
                    <Avatar name={p.name} />
                    <span className="grow">
                      <span className="name">{p.name}</span>
                      {!p.eligible && (
                        <span className="note">{p.age === null ? "Ingen fødselsdato, kan ikke få bøder" : `${p.age} år, under aldersgrænsen`}</span>
                      )}
                    </span>
                    {p.eligible && (
                      <>
                        <span className="pill">{kr(p.openOre)} skyldes</span>
                        <span className="pill">{kr(p.paidOre)} betalt</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <h2 style={{ marginTop: 20 }}>Seneste bøder</h2>
              {f.recent.length === 0 && <Empty icon="star">Ingen bøder endnu.</Empty>}
              <ul className="people">
                {f.recent.map((r) => (
                  <li key={r.id} className={r.cancelled ? "cancelled" : undefined}>
                    <span className="grow">
                      <span className={r.cancelled ? "name strike" : "name"}>
                        {r.playerName}: {r.description}
                      </span>
                      <span className="note">
                        {kr(r.amountOre)} · {shortDay(r.createdAt)}
                        {r.refunded ? " · betalt og tilbagebetalt" : r.cancelled ? " · trukket tilbage" : r.paid ? " · betalt" : ""}
                      </span>
                    </span>
                    {!r.cancelled && (
                      <>
                        <form action={payFineAction}>
                          {hidden({ fineId: r.id, paid: r.paid ? "0" : "1" })}
                          <button className="small">{r.paid ? "Fortryd betalt" : "Betalt"}</button>
                        </form>
                        <form action={cancelFineAction}>
                          {hidden({ fineId: r.id })}
                          <button className="link small">Træk tilbage</button>
                        </form>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {f.canManage && (
          <aside className="dash-side">
            <section className="card stack">
              <strong>Giv en bøde</strong>
              {eligible.length === 0 ? (
                <p className="muted small">Ingen på holdet er {f.minAge} år endnu.</p>
              ) : (
                <form action={giveFineAction} className="stack">
                  {hidden({})}
                  <label>
                    Til
                    <select name="profileId" required>
                      {eligible.map((p) => (
                        <option key={p.profileId} value={p.profileId}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Sats
                    <select name="fineTypeId" defaultValue={activeTypes[0]?.id ?? ""}>
                      {activeTypes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({kr(t.amountOre)})
                        </option>
                      ))}
                      <option value="">Andet (skriv selv)</option>
                    </select>
                  </label>
                  <details>
                    <summary className="small">Andet: tekst og beløb</summary>
                    <label>
                      Hvad
                      <input name="description" placeholder="Fx mobil i omklædningen" />
                    </label>
                    <label>
                      Beløb i kr.
                      <input name="amount" inputMode="decimal" placeholder="Fx 10" />
                    </label>
                    <p className="muted small">Bruges kun, når Sats er sat til Andet.</p>
                  </details>
                  <button className="primary">Giv bøde</button>
                </form>
              )}
              {tooYoung.length > 0 && <p className="muted small">{tooYoung.length} spillere er under {f.minAge} år og kan ikke få bøder.</p>}
            </section>

            <section className="card stack">
              <strong>Satser</strong>
              <p className="muted small">Holdet bestemmer selv satserne. Ændringer gælder kun nye bøder.</p>
              {f.types.map((t) => (
                <details key={t.id}>
                  <summary className={t.archived ? "small strike" : "small"}>
                    {t.name} · {kr(t.amountOre)}
                    {t.archived ? " (ikke i brug)" : ""}
                  </summary>
                  <form action={updateFineTypeAction} className="stack">
                    {hidden({ fineTypeId: t.id })}
                    <input name="name" defaultValue={t.name} required />
                    <input name="amount" defaultValue={krInput(t.amountOre)} inputMode="decimal" required />
                    <button>Gem</button>
                  </form>
                  <form action={archiveFineTypeAction}>
                    {hidden({ fineTypeId: t.id, archived: t.archived ? "0" : "1" })}
                    <button className="link small">{t.archived ? "Tag i brug igen" : "Tag ud af brug"}</button>
                  </form>
                </details>
              ))}
              <form action={createFineTypeAction} className="stack">
                {hidden({})}
                <input name="name" required placeholder="Ny sats, fx for sent til træning" />
                <input name="amount" required inputMode="decimal" placeholder="Beløb i kr." />
                <button>Tilføj sats</button>
              </form>
            </section>
          </aside>
        )}
      </div>
    </Shell>
  );
}
