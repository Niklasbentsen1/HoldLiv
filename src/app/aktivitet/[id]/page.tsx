import Link from "next/link";
import { getEventDetail } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { STATUS_LABEL, TYPE_LABEL, dayHeading, time, when } from "../../../lib/format";
import { Shell, ErrorBox } from "../../../components/Shell";
import { RespondForm } from "../../../components/RespondForm";
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

  return (
    <Shell ctx={ctx}>
      <Link href={`/hold/${e.teamId}`} className="muted small">
        ← {e.teamName}
      </Link>
      <div className="meta">
        <span className={`tag ${e.type}`}>{TYPE_LABEL[e.type]}</span>
        {cancelled && <span className="cancelled-note"> Aflyst</span>}
      </div>
      <h1 className={cancelled ? "strike" : undefined}>{e.title}</h1>
      <p>
        {when(e.startsAt, e.endsAt)}
        {e.location && (
          <>
            <br />
            {e.location}
          </>
        )}
      </p>
      {e.description && <p className="description">{e.description}</p>}
      {e.responseDeadline && !cancelled && (
        <p className="muted small">
          Svarfrist: {dayHeading(e.responseDeadline).toLowerCase()} kl. {time(e.responseDeadline)}
          {e.responsesClosed ? " (overskredet)" : ""}
        </p>
      )}
      <ErrorBox message={fejl} />

      {!cancelled &&
        mine.map((p) => (
          <section key={p.profileId} className="card stack">
            <strong>{mine.length > 1 || !p.mine ? p.firstName : `Dit svar for ${p.firstName}`}</strong>
            <RespondForm eventId={id} profileId={p.profileId} status={p.status} comment={p.comment} back={back} disabled={!p.canRespond} />
          </section>
        ))}

      <h2>
        Svar · {e.groups.yes.length} kommer af {e.players.length}
      </h2>
      {groups.map((g) =>
        g.list.length === 0 ? null : (
          <section key={g.key}>
            <h3 className={`group ${g.key}`}>
              {g.label} ({g.list.length})
            </h3>
            <ul className="people">
              {g.list.map((p) => (
                <li key={p.profileId}>
                  <span className="grow">
                    {p.name}
                    {(p.comment || p.respondedBy) && (
                      <span className="muted small block">
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
                        <button key={s} name="status" value={s} title={STATUS_LABEL[s]} className={p.status === s ? `mini ${s} active` : `mini ${s}`}>
                          {s === "yes" ? "✓" : "✕"}
                        </button>
                      ))}
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ),
      )}

      {e.canManage && (
        <section className="card stack">
          <strong>Træner</strong>
          <p className="muted small">Du kan registrere fremmøde for spillerne med ✓ og ✕, også efter svarfristen.</p>
          <div className="actions">
            <Link href={`/aktivitet/${id}/ret`} className="button">
              Ret
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
    </Shell>
  );
}
