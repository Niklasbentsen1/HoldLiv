import Link from "next/link";
import { listAdminClubs, listMyCertificates, listShiftTeams, listShifts, CERTIFICATE_STATE_LABEL } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { when } from "../../lib/format";
import { longDate } from "../../lib/money";
import { ErrorBox, Shell } from "../../components/Shell";
import { Empty, PageHead } from "../../components/ui";
import { cancelShiftAction, editShiftAction, giveCertificateConsentAction, leaveShiftAction, newShiftAction, takeShiftAction } from "../actions";

export const dynamic = "force-dynamic";

const toLocalInput = (d: Date) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d).replace(" ", "T");

function ShiftFields({ s }: { s?: { title: string; description: string | null; location: string | null; startsAt: Date; endsAt: Date; slots: number; requiresChildCertificate: boolean } }) {
  return (
    <>
      <label>
        Titel
        <input name="title" required maxLength={120} defaultValue={s?.title} placeholder="Fx Kioskvagt ved stævnet" />
      </label>
      <div className="row">
        <label>
          Fra
          <input type="datetime-local" name="startsAt" required defaultValue={s ? toLocalInput(s.startsAt) : undefined} />
        </label>
        <label>
          Til
          <input type="datetime-local" name="endsAt" required defaultValue={s ? toLocalInput(s.endsAt) : undefined} />
        </label>
      </div>
      <div className="row">
        <label>
          Pladser
          <input type="number" name="slots" min={1} max={200} defaultValue={s?.slots ?? 2} />
        </label>
        <label>
          Sted <span className="muted">(valgfrit)</span>
          <input name="location" defaultValue={s?.location ?? ""} />
        </label>
      </div>
      <label>
        Beskrivelse <span className="muted">(valgfri)</span>
        <input name="description" defaultValue={s?.description ?? ""} />
      </label>
      <label className="check">
        <input type="checkbox" name="requiresChildCertificate" value="1" defaultChecked={s?.requiresChildCertificate} /> Vagten kræver en gyldig børneattest
      </label>
    </>
  );
}

export default async function Vagtplan({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx } = await requireSession("/vagtplan");
  const [shifts, certificates, teams, adminClubs] = await Promise.all([listShifts(db, ctx), listMyCertificates(db, ctx), listShiftTeams(db, ctx), listAdminClubs(db, ctx)]);
  const scopes = [
    ...adminClubs.map((c) => ({ value: `${c.id}|`, label: `Hele ${c.name}` })),
    ...teams.map((t) => ({ value: `${t.clubId}|${t.id}`, label: t.name })),
  ];

  return (
    <Shell ctx={ctx} active="/vagtplan">
      <PageHead title="Vagtplan" sub="Frivillige vagter i foreningen. Tag en vagt, så vi ved, hvem der kommer." actions={<Link href="/kontrakter" className="muted small">Mine kontrakter</Link>} />
      <ErrorBox message={fejl} />

      {certificates.length > 0 && (
        <section>
          <h2>Børneattester</h2>
          <ul className="events">
            {certificates.map((c) => (
              <li key={c.id} className="card spread">
                <span className="grow">
                  <strong className="block">
                    {c.self ? "Din børneattest" : `${c.firstName}s børneattest`} · {c.club}
                  </strong>
                  <span className="muted small block">
                    {CERTIFICATE_STATE_LABEL[c.state]}
                    {c.expiresOn ? ` · gælder til ${longDate(c.expiresOn)}` : ""}
                    {c.reason ? ` · ${c.reason}` : ""}
                  </span>
                  {c.canConsent && (
                    <span className="muted small block">Foreningen må først bestille attesten hos Politiet, når der er sagt ja. HoldLiv gemmer kun status og datoer, aldrig selve attesten eller CPR-nummer.</span>
                  )}
                </span>
                {c.canConsent && (
                  <form action={giveCertificateConsentAction}>
                    <input type="hidden" name="certificateId" value={c.id} />
                    <button className="primary">Giv samtykke</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {scopes.length > 0 && (
        <details className="card">
          <summary className="title">Ny vagt</summary>
          <form action={newShiftAction} className="stack">
            <label>
              Til
              <select name="scope">
                {scopes.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <ShiftFields />
            <button className="primary">Opret vagt</button>
          </form>
        </details>
      )}

      <h2>Kommende vagter</h2>
      {shifts.length === 0 && <Empty icon="clock">Der er ingen vagter lige nu.</Empty>}
      <ul className="events">
        {shifts.map((s) => {
          const free = s.slots - s.filled;
          return (
            <li key={s.id} className="card stack">
              <div className="spread">
                <span className="title">{s.title}</span>
                <span className={free > 0 ? "tag paid" : "tag"}>{free > 0 ? `${free} ledige` : "Fuld"}</span>
              </div>
              <div className="muted small">
                {when(s.startsAt, s.endsAt)}
                {s.location ? ` · ${s.location}` : ""}
                {s.teamName ? ` · ${s.teamName}` : ""}
                {s.requiresChildCertificate ? " · kræver børneattest" : ""}
              </div>
              {s.description && <div className="small">{s.description}</div>}
              <div className="small">
                {s.volunteers.length === 0 ? (
                  <span className="muted">Ingen har taget vagten endnu.</span>
                ) : (
                  <ul className="people">
                    {s.volunteers.map((v) => (
                      <li key={v.profileId} className="spread">
                        <span>{v.name}</span>
                        {(v.mine || s.manage) && (
                          <form action={leaveShiftAction}>
                            <input type="hidden" name="shiftId" value={s.id} />
                            <input type="hidden" name="profileId" value={v.profileId} />
                            <button className="link small">Afmeld</button>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {free > 0 && s.options.some((o) => !o.signedUp && !o.tooYoung) && (
                <form action={takeShiftAction} className="row">
                  <input type="hidden" name="shiftId" value={s.id} />
                  <select name="profileId" aria-label="Hvem tager vagten">
                    {s.options
                      .filter((o) => !o.signedUp && !o.tooYoung)
                      .map((o) => (
                        <option key={o.profileId} value={o.profileId}>
                          {o.self ? "Mig selv" : o.firstName}
                          {o.missingCertificate ? " (mangler børneattest)" : ""}
                        </option>
                      ))}
                  </select>
                  <button className="primary">Tag vagten</button>
                </form>
              )}
              {s.manage && (
                <>
                  <details>
                    <summary className="small">Ret vagt</summary>
                    <form action={editShiftAction} className="stack">
                      <input type="hidden" name="shiftId" value={s.id} />
                      <ShiftFields s={s} />
                      <button>Gem</button>
                    </form>
                  </details>
                  <form action={cancelShiftAction}>
                    <input type="hidden" name="shiftId" value={s.id} />
                    <button>Aflys vagten</button>
                  </form>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}
