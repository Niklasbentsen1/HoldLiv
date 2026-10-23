import { getMatchSheet, getTeam } from "../../../../../services";
import { db } from "../../../../../lib/db";
import { requireSession } from "../../../../../lib/session";
import { when } from "../../../../../lib/format";
import { Shell, ErrorBox } from "../../../../../components/Shell";
import { Avatar, Empty, Icon, PageHead, Pitch } from "../../../../../components/ui";
import {
  addMatchEventAction,
  clearResultAction,
  publishLineupAction,
  recordResultAction,
  removeMatchEventAction,
  saveLineupAction,
  saveReportAction,
  unpublishReportAction,
} from "../../../../actions";

export const dynamic = "force-dynamic";

const KIND = { goal: "Mål", yellow: "Gult kort", red: "Rødt kort" } as const;
const RESPONSE = { yes: "Kommer", maybe: "Måske", no: "Kommer ikke" } as const;

export default async function Match({ params, searchParams }: { params: Promise<{ id: string; eventId: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { id, eventId } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/hold/${id}/kampe/${eventId}`);
  const team = await getTeam(db, ctx, id);
  const m = await getMatchSheet(db, ctx, eventId);
  const starters = m.lineup.filter((l) => l.slot === "start");
  const bench = m.lineup.filter((l) => l.slot === "bench");
  const started = m.event.startsAt.getTime() <= ctx.now.getTime();
  const hidden = (
    <>
      <input type="hidden" name="teamId" value={id} />
      <input type="hidden" name="eventId" value={eventId} />
    </>
  );
  const title = m.opponent ? `${team.name} mod ${m.opponent}` : m.event.title;

  return (
    <Shell ctx={ctx}>
      <PageHead back={{ href: `/hold/${id}/kampe`, label: "Kampe og opstilling" }} title={title} sub={`${when(m.event.startsAt)}${m.event.location ? ` · ${m.event.location}` : ""}${m.event.cancelled ? " · aflyst" : ""}`} />
      <ErrorBox message={fejl} />

      {m.played && (
        <section className="card brand" style={{ position: "relative", overflow: "hidden", marginBottom: 20, maxHeight: 190 }}>
          <Pitch />
          <span className="hero-eyebrow">Resultat</span>
          <h2 style={{ fontSize: 48, margin: "4px 0" }}>
            {m.goalsFor}–{m.goalsAgainst}
          </h2>
          <p>{m.goalsFor! > m.goalsAgainst! ? "Sejr" : m.goalsFor === m.goalsAgainst ? "Uafgjort" : "Nederlag"}</p>
        </section>
      )}

      <div className="team-layout">
        <div className="dash-main">
          <section className="section">
            <div className="section-head">
              <h2>Opstilling{m.formation ? ` · ${m.formation}` : ""}</h2>
              {m.canManage && <span className={m.lineupPublished ? "pill brand" : "pill"}>{m.lineupPublished ? "Udgivet" : "Kladde"}</span>}
            </div>
            {m.lineup.length === 0 && <Empty icon="ball">{m.canManage ? "Opstillingen er ikke lavet endnu." : "Opstillingen er ikke udgivet endnu."}</Empty>}
            {starters.length > 0 && (
              <>
                <h3>På banen</h3>
                <ul className="people">
                  {starters.map((l) => (
                    <li key={l.profileId}>
                      <Avatar name={l.name} />
                      <span className="grow">
                        <span className="name">{l.name}</span>
                        {l.minutes != null && <span className="note">{l.minutes} min.</span>}
                      </span>
                      {l.position && <span className="pill">{l.position}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {bench.length > 0 && (
              <>
                <h3>Bænken</h3>
                <ul className="people">
                  {bench.map((l) => (
                    <li key={l.profileId}>
                      <Avatar name={l.name} />
                      <span className="grow">
                        <span className="name">{l.name}</span>
                        {l.minutes != null && <span className="note">{l.minutes} min.</span>}
                      </span>
                      {l.position && <span className="pill">{l.position}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          {(m.played || m.events.length > 0) && (
            <section className="section">
              <div className="section-head">
                <h2>Mål og kort</h2>
              </div>
              {m.events.length === 0 && <Empty icon="star">Ingen mål noteret.</Empty>}
              <ul className="people">
                {m.events.map((e) => (
                  <li key={e.id}>
                    <span className="grow">
                      <span className="name">
                        {KIND[e.kind]}
                        {e.minute != null ? ` · ${e.minute}. min.` : ""}
                      </span>
                      <span className="note">
                        {e.playerName ?? (e.kind === "goal" ? "Målscorer ukendt" : "")}
                        {e.assistName ? ` · assist: ${e.assistName}` : ""}
                      </span>
                    </span>
                    {m.canManage && (
                      <form action={removeMatchEventAction}>
                        {hidden}
                        <input type="hidden" name="matchEventId" value={e.id} />
                        <button className="link small">Fjern</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(m.report || m.canManage) && (
            <section className="section">
              <div className="section-head">
                <h2>Kampreferat</h2>
                {m.canManage && m.report && <span className={m.reportPublished ? "pill brand" : "pill"}>{m.reportPublished ? "Udgivet" : "Kladde"}</span>}
              </div>
              {!m.canManage && m.report && <p style={{ whiteSpace: "pre-wrap" }}>{m.report}</p>}
              {m.canManage && (
                <form action={saveReportAction} className="stack">
                  {hidden}
                  <textarea name="report" rows={7} defaultValue={m.report ?? ""} placeholder="Skriv om kampen: hvad gik godt, hvem gjorde sig særligt bemærket, og hvad tager I med videre." />
                  <div className="row">
                    <button>Gem som kladde</button>
                    <button className="primary" name="publish" value="1">
                      {m.reportPublished ? "Gem og hold udgivet" : "Udgiv til holdet"}
                    </button>
                  </div>
                </form>
              )}
              {m.canManage && m.reportPublished && (
                <form action={unpublishReportAction}>
                  {hidden}
                  <button className="link small">Træk referatet tilbage til kladde</button>
                </form>
              )}
            </section>
          )}
        </div>

        {m.canManage && !m.event.cancelled && (
          <aside className="dash-side">
            <section className="card stack">
              <strong>Lav opstillingen</strong>
              <p className="muted small">
                Op til {m.startersCount} spillere på banen. Svaret fra kalenderen vises, så du ser hvem der kommer.
              </p>
              <form action={saveLineupAction} className="stack">
                {hidden}
                <div className="row">
                  <label>
                    Modstander
                    <input name="opponent" defaultValue={m.opponent ?? ""} maxLength={80} />
                  </label>
                  <label>
                    Opstilling
                    <input name="formation" defaultValue={m.formation ?? ""} maxLength={20} placeholder="Fx 2-3-1" />
                  </label>
                </div>
                {m.squad.map((p) => {
                  const current = m.lineup.find((l) => l.profileId === p.profileId);
                  return (
                    <div key={p.profileId} className="stack" style={{ gap: 4 }}>
                      <input type="hidden" name="profileId" value={p.profileId} />
                      <span className="name">
                        {p.name} {p.response && <span className={p.response === "no" ? "pill cancel" : "pill"}>{RESPONSE[p.response]}</span>}
                      </span>
                      <div className="row">
                        <select name={`slot_${p.profileId}`} defaultValue={p.slot ?? ""} aria-label={`Plads for ${p.name}`}>
                          <option value="">Ikke med</option>
                          <option value="start">På banen</option>
                          <option value="bench">Bænken</option>
                        </select>
                        <input name={`pos_${p.profileId}`} defaultValue={current?.position ?? ""} maxLength={40} placeholder="Position" aria-label={`Position for ${p.name}`} />
                      </div>
                    </div>
                  );
                })}
                <button className="primary">Gem opstilling</button>
              </form>
              <form action={publishLineupAction}>
                {hidden}
                <input type="hidden" name="published" value={m.lineupPublished ? "0" : "1"} />
                <button>{m.lineupPublished ? "Træk opstillingen tilbage" : "Udgiv opstillingen og giv besked"}</button>
              </form>
            </section>

            {started ? (
              <>
                <section className="card stack">
                  <strong>Resultat og spilletid</strong>
                  <form action={recordResultAction} className="stack">
                    {hidden}
                    <div className="row">
                      <label>
                        Vores mål
                        <input type="number" name="goalsFor" min={0} max={99} required defaultValue={m.goalsFor ?? ""} />
                      </label>
                      <label>
                        Modstanderens
                        <input type="number" name="goalsAgainst" min={0} max={99} required defaultValue={m.goalsAgainst ?? ""} />
                      </label>
                    </div>
                    {m.lineup.length > 0 && <span className="muted small">Spilletid i minutter (valgfrit)</span>}
                    {m.lineup.map((l) => (
                      <label key={l.profileId}>
                        <input type="hidden" name="profileId" value={l.profileId} />
                        {l.name}
                        <input type="number" name={`min_${l.profileId}`} min={0} max={150} defaultValue={l.minutes ?? ""} />
                      </label>
                    ))}
                    <button className="primary">{m.played ? "Ret resultatet" : "Gem resultatet"}</button>
                  </form>
                  {m.played && (
                    <form action={clearResultAction}>
                      {hidden}
                      <button className="link small">Fjern resultatet</button>
                    </form>
                  )}
                </section>

                {m.lineup.length > 0 && (
                  <section className="card stack">
                    <strong>Noter mål eller kort</strong>
                    <form action={addMatchEventAction} className="stack">
                      {hidden}
                      <label>
                        Hvad
                        <select name="kind">
                          <option value="goal">Mål til os</option>
                          <option value="yellow">Gult kort</option>
                          <option value="red">Rødt kort</option>
                        </select>
                      </label>
                      <label>
                        Spiller
                        <select name="playerId" defaultValue="">
                          <option value="">Ukendt</option>
                          {m.lineup.map((l) => (
                            <option key={l.profileId} value={l.profileId}>
                              {l.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Assist (kun mål)
                        <select name="assistId" defaultValue="">
                          <option value="">Ingen</option>
                          {m.lineup.map((l) => (
                            <option key={l.profileId} value={l.profileId}>
                              {l.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Minut (valgfrit)
                        <input type="number" name="minute" min={0} max={150} />
                      </label>
                      <button>Tilføj</button>
                    </form>
                  </section>
                )}
              </>
            ) : (
              <p className="muted small">
                <Icon name="clock" size={14} /> Resultat, mål og kort kan indtastes, når kampen er begyndt.
              </p>
            )}
          </aside>
        )}
      </div>
    </Shell>
  );
}
