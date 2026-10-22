import Link from "next/link";
import { getEventDetail } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { STATUS_LABEL, dayHeading, time, when } from "../../../lib/format";
import { Shell, ErrorBox } from "../../../components/Shell";
import { RespondForm } from "../../../components/RespondForm";
import { Avatar, Icon, PageHead, Pitch, Ring, TypeBadge } from "../../../components/ui";
import { cancelEvent, respond } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EventPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { id } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/aktivitet/${id}`);
  const e = await getEventDetail(db, ctx, id);
  const back = `/aktivitet/${id}`;
  const mine = e.players.filter((p) => p.mine);
  const cancelled = !!e.cancelledAt;
  const groups = [
    { key: "yes", label: "Kommer", list: e.groups.yes },
    { key: "maybe", label: "Måske", list: e.groups.maybe },
    { key: "no", label: "Kommer ikke", list: e.groups.no },
    { key: "none", label: "Ikke svaret", list: e.groups.none },
  ] as const;

  const total = e.players.length;
  const share = total ? Math.round((e.groups.yes.length / total) * 100) : null;
  const pct = (n: number) => `${total ? (n / total) * 100 : 0}%`;

  return (
    <Shell admin={ctx.adminClubs.size > 0}>
      <PageHead back={{ href: `/hold/${e.teamId}`, label: e.teamName }} />
      <ErrorBox message={fejl} />

      <div className="team-layout">
        <div className="dash-main">
          <section className="hero event-hero">
            <Pitch />
            <div className="hero-top">
              <TypeBadge type={e.type} />
              {cancelled && <span className="pill cancel">Aflyst</span>}
            </div>
            <h2 className={cancelled ? "strike" : undefined}>{e.title}</h2>
            <div className="facts">
              <div className="fact">
                <span className="icon-bubble">
                  <Icon name="calendar" size={18} />
                </span>
                <span>
                  <small>Hvornår</small>
                  <strong>{when(e.startsAt, e.endsAt).replace(/^./, (c) => c.toUpperCase())}</strong>
                </span>
              </div>
              {e.location && (
                <div className="fact">
                  <span className="icon-bubble">
                    <Icon name="pin" size={18} />
                  </span>
                  <span>
                    <small>Hvor</small>
                    <strong>{e.location}</strong>
                  </span>
                </div>
              )}
              {e.responseDeadline && !cancelled && (
                <div className="fact">
                  <span className="icon-bubble">
                    <Icon name="clock" size={18} />
                  </span>
                  <span>
                    <small>Svarfrist{e.responsesClosed ? " (overskredet)" : ""}</small>
                    <strong>
                      {dayHeading(e.responseDeadline)} kl. {time(e.responseDeadline)}
                    </strong>
                  </span>
                </div>
              )}
            </div>
            {e.description && <p className="description">{e.description}</p>}
            {!cancelled &&
              mine.map((p) => (
                <div key={p.profileId} className="stack" style={{ gap: 0 }}>
                  <span className="hero-eyebrow">{mine.length > 1 || !p.mine ? p.firstName : `Dit svar for ${p.firstName}`}</span>
                  <RespondForm eventId={id} profileId={p.profileId} status={p.status} comment={p.comment} back={back} disabled={!p.canRespond} />
                </div>
              ))}
          </section>

          <section>
            <div className="section-head">
              <h2>Svar</h2>
            </div>
            {groups.map((g) =>
              g.list.length === 0 ? null : (
                <div key={g.key}>
                  <h3 className="group-title">
                    <i className={g.key} />
                    {g.label} <span className="muted">· {g.list.length}</span>
                  </h3>
                  <ul className="people">
                    {g.list.map((p) => (
                      <li key={p.profileId}>
                        <Avatar name={p.name} />
                        <span className="grow">
                          <span className="name">{p.name}</span>
                          {(p.comment || p.respondedBy) && (
                            <span className="note">
                              {p.comment ? `"${p.comment}"` : ""}
                              {p.comment && p.respondedBy ? " · " : ""}
                              {p.respondedBy ? `svaret af ${p.respondedBy}` : ""}
                            </span>
                          )}
                        </span>
                        {e.canManage && !cancelled && (
                          <form action={respond} className="mini-answers">
                            <input type="hidden" name="eventId" value={id} />
                            <input type="hidden" name="profileId" value={p.profileId} />
                            <input type="hidden" name="back" value={back} />
                            {(["yes", "no"] as const).map((s) => (
                              <button key={s} name="status" value={s} title={STATUS_LABEL[s]} aria-label={STATUS_LABEL[s]} className={p.status === s ? `mini ${s} active` : `mini ${s}`}>
                                <Icon name={s === "yes" ? "check" : "x"} size={16} />
                              </button>
                            ))}
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </section>
        </div>

        <aside className="dash-side">
          <section className="card stack">
            <div className="summary-row">
              <Ring value={share} size={96} stroke={11} tone="yes" label={`${e.groups.yes.length}/${total}`} />
              <span className="grow">
                <strong style={{ fontSize: 18 }}>{e.groups.yes.length} kommer</strong>
                <span className="meter">
                  <i className="yes" style={{ width: pct(e.groups.yes.length) }} />
                  <i className="maybe" style={{ width: pct(e.groups.maybe.length) }} />
                  <i className="no" style={{ width: pct(e.groups.no.length) }} />
                </span>
                <span className="small muted">
                  {e.groups.maybe.length} måske · {e.groups.no.length} kommer ikke · {e.groups.none.length} mangler
                </span>
              </span>
            </div>
          </section>

          {e.canManage && (
            <section className="card stack">
              <div className="stat-top">
                <strong>Træner</strong>
                <span className="icon-bubble">
                  <Icon name="whistle" size={18} />
                </span>
              </div>
              <p className="muted small">Du kan registrere fremmøde for spillerne med ✓ og ✕, også efter svarfristen.</p>
              <div className="actions">
                <Link href={`/aktivitet/${id}/ret`} className="button">
                  <Icon name="edit" size={16} /> Ret
                </Link>
                <form action={cancelEvent}>
                  <input type="hidden" name="eventId" value={id} />
                  <input type="hidden" name="cancelled" value={cancelled ? "0" : "1"} />
                  <button className={cancelled ? "button" : "button danger"}>{cancelled ? "Genopret" : "Aflys"}</button>
                </form>
                {e.seriesId && !cancelled && (
                  <form action={cancelEvent}>
                    <input type="hidden" name="eventId" value={id} />
                    <input type="hidden" name="cancelled" value="1" />
                    <input type="hidden" name="scope" value="following" />
                    <button className="button danger">Aflys denne og resten af serien</button>
                  </form>
                )}
              </div>
            </section>
          )}
        </aside>
      </div>
    </Shell>
  );
}
