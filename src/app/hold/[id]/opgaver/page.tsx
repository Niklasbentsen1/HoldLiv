import { getTeam, listFruitCandidates, listTaskEvents, listTasks } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { shortDay, time } from "../../../../lib/format";
import { Shell, ErrorBox } from "../../../../components/Shell";
import { Avatar, Empty, PageHead } from "../../../../components/ui";
import {
  assignTaskAction,
  claimTaskAction,
  createFruitListAction,
  createTaskAction,
  deleteTaskAction,
  distributeTasksAction,
  doneTaskAction,
  releaseTaskAction,
} from "../../../actions";

export const dynamic = "force-dynamic";

export default async function Tasks({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { id } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/hold/${id}/opgaver`);
  const team = await getTeam(db, ctx, id);
  const list = await listTasks(db, ctx, id);
  const candidates = list.canManage ? await listFruitCandidates(db, ctx, id) : [];
  const upcoming = candidates;
  const taskEvents = list.canManage ? await listTaskEvents(db, ctx, id) : [];
  const unassigned = list.open.filter((t) => !t.assignee).length;
  const sections = [
    { kind: "fruit", title: "Frugtliste", empty: "Ingen frugt på listen endnu." },
    { kind: "task", title: "Opgaver", empty: "Ingen opgaver endnu." },
  ] as const;

  return (
    <Shell ctx={ctx}>
      <PageHead back={{ href: `/hold/${id}`, label: team.name }} title="Frugt og opgaver" sub="Hvem har frugt med, og hvem kridter og rydder op. Fordelt retfærdigt på familierne." />
      <ErrorBox message={fejl} />

      <div className="team-layout">
        <div className="dash-main">
          {sections.map((s) => {
            const items = list.open.filter((t) => t.kind === s.kind);
            return (
              <section key={s.kind} className="section">
                <div className="section-head">
                  <h2>{s.title}</h2>
                </div>
                {items.length === 0 && <Empty icon="star">{s.empty}</Empty>}
                <ul className="stack" style={{ padding: 0, margin: 0, listStyle: "none" }}>
                  {items.map((t) => (
                    <li key={t.id} className="card stack">
                      <div className="spread">
                        <span>
                          <strong>{t.title}</strong>
                          {t.event && (
                            <span className="muted small block">
                              {t.event.title} · {shortDay(t.event.startsAt)} kl. {time(t.event.startsAt)}
                            </span>
                          )}
                        </span>
                        {t.assignee ? (
                          <span className={t.mine ? "pill brand" : "pill"}>
                            <Avatar name={t.assignee.name} size={20} /> {t.assignee.name}
                            {t.mine && " (jer)"}
                          </span>
                        ) : (
                          <span className="pill cancel">Mangler en familie</span>
                        )}
                      </div>
                      {t.note && <p className="muted small">{t.note}</p>}
                      <div className="actions">
                        {t.canClaim &&
                          list.myFamilies.map((f) => (
                            <form key={f.assigneeId} action={claimTaskAction}>
                              <input type="hidden" name="teamId" value={id} />
                              <input type="hidden" name="taskId" value={t.id} />
                              <input type="hidden" name="profileId" value={f.assigneeId} />
                              <button className="primary">{list.myFamilies.length > 1 ? `Vi tager den (${f.name})` : "Vi tager den"}</button>
                            </form>
                          ))}
                        {t.canComplete && (
                          <form action={doneTaskAction}>
                            <input type="hidden" name="teamId" value={id} />
                            <input type="hidden" name="taskId" value={t.id} />
                            <input type="hidden" name="done" value="1" />
                            <button>Udført</button>
                          </form>
                        )}
                        {t.canRelease && (
                          <form action={releaseTaskAction}>
                            <input type="hidden" name="teamId" value={id} />
                            <input type="hidden" name="taskId" value={t.id} />
                            <button className="link small">{t.mine ? "Vi kan ikke alligevel" : "Fjern familien"}</button>
                          </form>
                        )}
                      </div>
                      {list.canManage && (
                        <details>
                          <summary className="small">Træner: skriv på en familie eller slet</summary>
                          <form action={assignTaskAction} className="inline">
                            <input type="hidden" name="teamId" value={id} />
                            <input type="hidden" name="taskId" value={t.id} />
                            <select name="profileId" defaultValue={t.assignee?.profileId ?? ""}>
                              <option value="">Ingen familie</option>
                              {list.families.map((f) => (
                                <option key={f.assigneeId} value={f.assigneeId}>
                                  {f.name}
                                </option>
                              ))}
                            </select>
                            <button>Gem</button>
                          </form>
                          <form action={deleteTaskAction}>
                            <input type="hidden" name="teamId" value={id} />
                            <input type="hidden" name="taskId" value={t.id} />
                            <button className="link small">Slet opgaven</button>
                          </form>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          {list.done.length > 0 && (
            <details>
              <summary>Udført ({list.done.length})</summary>
              <ul className="people">
                {list.done.map((t) => (
                  <li key={t.id}>
                    <span className="grow">
                      <span className="name">{t.title}</span>
                      <span className="note">
                        {t.assignee?.name}
                        {t.event ? ` · ${shortDay(t.event.startsAt)}` : ""}
                      </span>
                    </span>
                    {t.canComplete && (
                      <form action={doneTaskAction}>
                        <input type="hidden" name="teamId" value={id} />
                        <input type="hidden" name="taskId" value={t.id} />
                        <input type="hidden" name="done" value="0" />
                        <button className="link small">Fortryd</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>

        <aside className="dash-side">
          {list.canManage && (
            <section className="card stack">
              <strong>Træner</strong>
              {unassigned > 0 && (
                <form action={distributeTasksAction}>
                  <input type="hidden" name="teamId" value={id} />
                  <button className="primary">Fordel de {unassigned} ledige retfærdigt</button>
                </form>
              )}
              <details>
                <summary>Lav frugtliste</summary>
                <form action={createFruitListAction} className="stack">
                  <input type="hidden" name="teamId" value={id} />
                  <p className="muted small">Vælg de aktiviteter, der skal have frugt. De fordeles straks på familierne.</p>
                  {upcoming.length === 0 && <p className="muted small">Alle kommende aktiviteter har allerede frugt.</p>}
                  {upcoming.map((e) => (
                    <label key={e.id} className="check">
                      <input type="checkbox" name="eventId" value={e.id} /> {e.title} · {shortDay(e.startsAt)} kl. {time(e.startsAt)}
                    </label>
                  ))}
                  {upcoming.length > 0 && <button>Lav frugtliste</button>}
                </form>
              </details>
              <details>
                <summary>Ny opgave</summary>
                <form action={createTaskAction} className="stack">
                  <input type="hidden" name="teamId" value={id} />
                  <input type="hidden" name="kind" value="task" />
                  <label>
                    Opgave
                    <input name="title" required placeholder="Fx kridt banen" />
                  </label>
                  <label>
                    Til aktivitet (valgfrit)
                    <select name="eventId" defaultValue="">
                      <option value="">Ingen bestemt</option>
                      {taskEvents.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.title} · {shortDay(e.startsAt)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Besked (valgfrit)
                    <input name="note" />
                  </label>
                  <button>Opret opgave</button>
                </form>
              </details>
            </section>
          )}

          <section>
            <div className="section-head">
              <h2>Hvem har haft hvad</h2>
            </div>
            <ul className="people">
              {list.families.map((f) => (
                <li key={f.assigneeId}>
                  <Avatar name={f.name} />
                  <span className="name grow">{f.name}</span>
                  <span className="pill">{f.fruit} frugt</span>
                  <span className="pill">{f.tasks} opg.</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </Shell>
  );
}
