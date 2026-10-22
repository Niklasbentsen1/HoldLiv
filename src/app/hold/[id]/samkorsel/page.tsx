import { getEventCarpool, getTeam, listCarpoolEvents } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { dayHeading, shortDay, time } from "../../../../lib/format";
import { toLocalInput } from "../../../../lib/time";
import { Shell, ErrorBox } from "../../../../components/Shell";
import { Avatar, DateTile, Empty, PageHead } from "../../../../components/ui";
import {
  bookSeatAction,
  cancelOfferAction,
  cancelRideRequestAction,
  leaveSeatAction,
  offerRideAction,
  requestRideAction,
  updateOfferAction,
} from "../../../actions";

export const dynamic = "force-dynamic";

function Hidden({ teamId, eventId, ...rest }: { teamId: string; eventId: string; [k: string]: string }) {
  return (
    <>
      <input type="hidden" name="teamId" value={teamId} />
      <input type="hidden" name="eventId" value={eventId} />
      {Object.entries(rest).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

function OfferFields({ defaults }: { defaults?: { seats: number; meetingPoint: string; departsAt: Date | null; note: string | null } }) {
  return (
    <>
      <div className="row">
        <label>
          Pladser til andre
          <input type="number" name="seats" min={1} max={8} required defaultValue={defaults?.seats ?? 3} />
        </label>
        <label>
          Afgang (valgfrit)
          <input type="datetime-local" name="departsAt" defaultValue={defaults?.departsAt ? toLocalInput(defaults.departsAt) : ""} />
        </label>
      </div>
      <label>
        Mødested
        <input name="meetingPoint" required defaultValue={defaults?.meetingPoint ?? ""} placeholder="Fx parkeringspladsen ved skolen" />
      </label>
      <label>
        Besked (valgfrit)
        <input name="note" defaultValue={defaults?.note ?? ""} />
      </label>
    </>
  );
}

export default async function Carpool({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fejl?: string }> }) {
  const { id } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/hold/${id}/samkorsel`);
  const team = await getTeam(db, ctx, id);
  const upcoming = await listCarpoolEvents(db, ctx, id);
  const details = await Promise.all(upcoming.map(async (e) => ({ e, c: await getEventCarpool(db, ctx, e.id) })));

  return (
    <Shell ctx={ctx}>
      <PageHead back={{ href: `/hold/${id}`, label: team.name }} title="Samkørsel" sub="Hvem kører, og hvem mangler en lift. Tilbyd pladser, eller sæt dit barn på en bil." />
      <ErrorBox message={fejl} />
      {details.length === 0 && <Empty>Ingen kommende aktiviteter.</Empty>}
      <ul className="stack" style={{ maxWidth: 760, padding: 0, margin: 0, listStyle: "none" }}>
        {details.map(({ e, c }) => (
          <li key={e.id} id={`e${e.id}`} className="card">
            {/* Kampe og aktiviteter med samkørsel står åbne; almindelige træninger er foldet sammen. */}
            <details open={e.type === "match" || c.offers.length > 0 || c.requests.length > 0} className="stack">
            <summary style={{ listStyle: "none", cursor: "pointer" }}>
              <span className="row-card" style={{ padding: 0, boxShadow: "none" }}>
                <DateTile date={e.startsAt} type={e.type} />
                <span className="grow">
                  <strong>{e.title}</strong>
                  <span className="muted small block">
                    {dayHeading(e.startsAt)} kl. {time(e.startsAt)}
                    {e.location ? ` · ${e.location}` : ""}
                  </span>
                </span>
                {c.offers.length > 0 && <span className="pill brand">{c.offers.length} {c.offers.length === 1 ? "bil" : "biler"}</span>}
                {c.requests.length > 0 && <span className="pill cancel">{c.requests.length} mangler lift</span>}
              </span>
            </summary>

            {c.offers.length === 0 && <p className="muted small">Ingen har tilbudt at køre endnu.</p>}
            {c.offers.map((o) => (
              <div key={o.id} className="card flat stack">
                <div className="spread">
                  <strong>
                    {o.driverName}
                    {o.mine && <span className="muted"> (dig)</span>}
                  </strong>
                  <span className={o.free ? "pill brand" : "pill"}>{o.free ? `${o.free} af ${o.seats} pladser ledige` : "Fuld"}</span>
                </div>
                <p className="small">
                  Mødested: {o.meetingPoint}
                  {o.departsAt ? ` · afgang ${shortDay(o.departsAt)} kl. ${time(o.departsAt)}` : ""}
                  {o.driverPhone ? ` · ${o.driverPhone}` : ""}
                </p>
                {o.note && <p className="muted small">{o.note}</p>}
                <ul className="people">
                  {o.passengers.map((p) => (
                    <li key={p.profileId}>
                      <Avatar name={p.name} size={28} />
                      <span className="grow">
                        <span className="name">{p.name}</span>
                        {p.guardianPhones.length > 0 && <span className="note">{p.guardianPhones.join(" · ")}</span>}
                      </span>
                      {p.canRemove && (
                        <form action={leaveSeatAction}>
                          <Hidden teamId={id} eventId={e.id} offerId={o.id} profileId={p.profileId} />
                          <button className="link small">Tag af</button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
                {[...o.bookable, ...o.movable].length > 0 && (
                  <div className="actions">
                    {o.bookable.map((p) => (
                      <form key={p.id} action={bookSeatAction}>
                        <Hidden teamId={id} eventId={e.id} offerId={o.id} profileId={p.id} />
                        <button>Sæt {p.firstName} på</button>
                      </form>
                    ))}
                    {o.movable.map((p) => (
                      <form key={p.id} action={bookSeatAction}>
                        <Hidden teamId={id} eventId={e.id} offerId={o.id} profileId={p.id} />
                        <button>Flyt {p.firstName} hertil</button>
                      </form>
                    ))}
                  </div>
                )}
                {o.canManage && (
                  <details>
                    <summary className="small">Ret eller slet</summary>
                    <form action={updateOfferAction} className="stack">
                      <Hidden teamId={id} eventId={e.id} offerId={o.id} />
                      <OfferFields defaults={o} />
                      <button className="primary">Gem</button>
                    </form>
                    <form action={cancelOfferAction}>
                      <Hidden teamId={id} eventId={e.id} offerId={o.id} />
                      <button className="link small">Slet samkørslen</button>
                    </form>
                  </details>
                )}
              </div>
            ))}

            {c.requests.length > 0 && (
              <div className="stack">
                <strong className="small">Mangler en lift</strong>
                <ul className="people">
                  {c.requests.map((r) => (
                    <li key={r.profileId}>
                      <Avatar name={r.name} size={28} />
                      <span className="grow">
                        <span className="name">{r.name}</span>
                        {r.note && <span className="note">{r.note}</span>}
                      </span>
                      {r.takeIn.map((t) => (
                        <form key={t.offerId} action={bookSeatAction}>
                          <Hidden teamId={id} eventId={e.id} offerId={t.offerId} profileId={r.profileId} />
                          <button className="small">Tag med{r.takeIn.length > 1 ? ` hos ${t.driverName.split(" ")[0]}` : ""}</button>
                        </form>
                      ))}
                      {r.canCancel && (
                        <form action={cancelRideRequestAction}>
                          <Hidden teamId={id} eventId={e.id} profileId={r.profileId} />
                          <button className="link small">Fortryd</button>
                        </form>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {c.canRequestFor.map((p) => (
              <form key={p.id} action={requestRideAction} className="inline">
                <Hidden teamId={id} eventId={e.id} profileId={p.id} />
                <input name="note" placeholder="Besked (valgfrit)" />
                <button>{p.firstName} mangler en lift</button>
              </form>
            ))}

            {c.canOffer && (
              <details>
                <summary>Jeg kan køre</summary>
                <form action={offerRideAction} className="stack">
                  <Hidden teamId={id} eventId={e.id} />
                  <OfferFields />
                  <button className="primary">Tilbyd pladser</button>
                </form>
              </details>
            )}
            </details>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
