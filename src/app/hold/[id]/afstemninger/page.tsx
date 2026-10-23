import { getTeam, listPolls } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { when } from "../../../../lib/format";
import { Shell, ErrorBox } from "../../../../components/Shell";
import { Empty, PageHead } from "../../../../components/ui";
import { closePollAction, createPollAction, deletePollAction, votePollAction, withdrawVoteAction } from "../../../actions";

export const dynamic = "force-dynamic";

export default async function Polls({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { id } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/hold/${id}/afstemninger`);
  const team = await getTeam(db, ctx, id);
  const data = await listPolls(db, ctx, id);

  return (
    <Shell ctx={ctx}>
      <PageHead back={{ href: `/hold/${id}`, label: team.name }} title="Afstemninger" sub="Én stemme pr. spiller. Forældre stemmer for deres børn." />
      <ErrorBox message={fejl} />

      <div className="team-layout">
        <div className="dash-main">
          {data.polls.length === 0 && <Empty icon="star">Der er ingen afstemninger endnu.</Empty>}
          {data.polls.map((p) => (
            <section key={p.id} className="card stack">
              <div className="spread">
                <strong className="grow">{p.question}</strong>
                <span className={p.open ? "pill brand" : "pill"}>{p.open ? "Åben" : "Lukket"}</span>
              </div>
              {p.description && <p className="muted small">{p.description}</p>}
              <p className="muted small">
                {p.multiple ? "Du kan vælge flere svar." : "Vælg ét svar."} {p.anonymous ? "Anonym afstemning." : ""}
                {p.open && p.closesAt ? ` Lukker ${when(p.closesAt, null)}.` : ""}
              </p>

              {p.showResults && (
                <ul className="people">
                  {p.options.map((o) => (
                    <li key={o.id}>
                      <span className="grow">
                        <span className="name">{o.label}</span>
                        {o.names.length > 0 && <span className="note">{o.names.join(", ")}</span>}
                      </span>
                      <span className="pill">{o.count}</span>
                    </li>
                  ))}
                </ul>
              )}
              {p.showResults && (
                <p className="muted small">
                  {p.voterCount} af {p.eligible} har stemt.
                </p>
              )}

              {p.open &&
                data.voters.map((v) => {
                  const mine = p.myVotes.find((m) => m.profileId === v.profileId)?.optionIds ?? [];
                  return (
                    <form key={v.profileId} action={votePollAction} className="stack">
                      <input type="hidden" name="teamId" value={id} />
                      <input type="hidden" name="pollId" value={p.id} />
                      <input type="hidden" name="profileId" value={v.profileId} />
                      <strong className="small">{v.self ? "Din stemme" : `Stemme for ${v.name}`}</strong>
                      {p.options.map((o) => (
                        <label key={o.id} className="check">
                          <input type={p.multiple ? "checkbox" : "radio"} name="optionId" value={o.id} defaultChecked={mine.includes(o.id)} required={!p.multiple} /> {o.label}
                        </label>
                      ))}
                      <button className="primary">{mine.length ? "Skift stemme" : "Stem"}</button>
                    </form>
                  );
                })}
              {p.open &&
                data.voters.map((v) => {
                  const mine = p.myVotes.find((m) => m.profileId === v.profileId)?.optionIds ?? [];
                  return mine.length ? (
                    <form key={v.profileId} action={withdrawVoteAction}>
                      <input type="hidden" name="teamId" value={id} />
                      <input type="hidden" name="pollId" value={p.id} />
                      <input type="hidden" name="profileId" value={v.profileId} />
                      <button className="link small">Træk {v.self ? "din" : `${v.name.split(" ")[0]}s`} stemme tilbage</button>
                    </form>
                  ) : null;
                })}

              {data.canManage && (
                <div className="row">
                  {p.open && (
                    <form action={closePollAction}>
                      <input type="hidden" name="teamId" value={id} />
                      <input type="hidden" name="pollId" value={p.id} />
                      <button className="small">Luk afstemning</button>
                    </form>
                  )}
                  <form action={deletePollAction}>
                    <input type="hidden" name="teamId" value={id} />
                    <input type="hidden" name="pollId" value={p.id} />
                    <button className="link small">Slet</button>
                  </form>
                </div>
              )}
            </section>
          ))}
        </div>

        {data.canManage && (
          <aside className="dash-side">
            <section className="card stack">
              <strong>Ny afstemning</strong>
              <form action={createPollAction} className="stack">
                <input type="hidden" name="teamId" value={id} />
                <label>
                  Spørgsmål
                  <input name="question" required maxLength={200} placeholder="Fx hvornår skal vi holde sæsonafslutning?" />
                </label>
                <label>
                  Svarmuligheder <span className="muted">(ét pr. linje, 2 til 10)</span>
                  <textarea name="options" required rows={4} placeholder={"Fredag den 5. juni\nLørdag den 6. juni"} />
                </label>
                <label>
                  Uddybning <span className="muted">(valgfri)</span>
                  <input name="description" />
                </label>
                <label>
                  Lukker <span className="muted">(valgfrit)</span>
                  <input type="datetime-local" name="closesAt" />
                </label>
                <label className="check">
                  <input type="checkbox" name="multiple" value="1" /> Man må vælge flere svar
                </label>
                <label className="check">
                  <input type="checkbox" name="anonymous" value="1" /> Anonym (heller ikke trænerne ser, hvem der stemte hvad)
                </label>
                <button className="primary">Start afstemning</button>
              </form>
            </section>
          </aside>
        )}
      </div>
    </Shell>
  );
}
