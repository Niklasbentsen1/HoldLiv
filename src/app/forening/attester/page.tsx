import Link from "next/link";
import { CERTIFICATE_STATE_LABEL, EXPIRY_WARNING_DAYS, listCertificateGaps, listClubCertificates, listClubPeople } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { addDays, localDate, longDate } from "../../../lib/money";
import { ErrorBox, Shell } from "../../../components/Shell";
import { Empty, PageHead } from "../../../components/ui";
import { certificateStepAction, requireCertificateAction } from "../../actions";

export const dynamic = "force-dynamic";

/** Forslag til udløbsdato: tre år frem. Foreningen bestemmer selv. */
const suggestExpiry = (today: string) => `${Number(today.slice(0, 4)) + 3}${today.slice(4)}`;

export default async function Certificates({ searchParams }: { searchParams: Promise<{ klub?: string; fejl?: string }> }) {
  const { klub, fejl } = await searchParams;
  const { ctx } = await requireSession(`/forening/attester?klub=${klub ?? ""}`);
  if (!klub || !ctx.adminClubs.has(klub)) return <Shell ctx={ctx}>Kun foreningens administratorer har adgang her.</Shell>;
  const [list, gaps, people] = await Promise.all([listClubCertificates(db, ctx, klub), listCertificateGaps(db, ctx, klub), listClubPeople(db, ctx, klub)]);
  const today = localDate(ctx.now);

  return (
    <Shell active="/forening" ctx={ctx}>
      <PageHead
        back={{ href: "/forening", label: "Forening" }}
        title="Børneattester"
        sub="Hold styr på, hvem der skal have en børneattest, om der er samtykke, og hvornår den udløber."
        actions={<Link href={`/forening/kontrakter?klub=${klub}`} className="muted small">Kontrakter</Link>}
      />
      <ErrorBox message={fejl} />
      <p className="muted small" style={{ maxWidth: 640, marginBottom: 16 }}>
        Selve attesten hentes hos Politiet (via virk.dk) med foreningens eget login, og først når personen har givet samtykke. HoldLiv gemmer aldrig attesten eller CPR-nummer, kun status og datoer. Foreningen sætter selv, hvornår en attest skal fornyes; I får en påmindelse {EXPIRY_WARNING_DAYS} dage før.
      </p>

      {gaps.length > 0 && (
        <section>
          <h2>Mangler attest</h2>
          <ul className="events">
            {gaps.map((g) => (
              <li key={g.profileId} className="card spread">
                <span className="grow">
                  <strong className="block">{g.name}</strong>
                  <span className="muted small block">
                    {g.reason}
                    {g.expired ? " · tidligere attest er udløbet eller ikke godkendt" : ""}
                  </span>
                </span>
                <form action={requireCertificateAction}>
                  <input type="hidden" name="clubId" value={klub} />
                  <input type="hidden" name="profileId" value={g.profileId} />
                  <input type="hidden" name="reason" value={g.reason} />
                  <button className="primary">Kræv attest</button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="card">
        <summary className="title">Kræv attest af en anden</summary>
        <form action={requireCertificateAction} className="stack">
          <input type="hidden" name="clubId" value={klub} />
          <label>
            Person
            <select name="profileId" required>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Hvorfor <span className="muted">(valgfrit)</span>
            <input name="reason" maxLength={200} placeholder="Fx Hjælper ved U9" />
          </label>
          <button className="primary">Kræv attest</button>
        </form>
      </details>

      <h2>Alle attester</h2>
      {list.length === 0 && <Empty icon="club">Ingen attester endnu.</Empty>}
      <ul className="events">
        {list.map((c) => (
          <li key={c.id} className="card stack">
            <div className="spread">
              <span className="grow">
                <strong className="block">{c.name}</strong>
                <span className="muted small block">
                  {c.reason ? `${c.reason} · ` : ""}
                  {c.consentAt ? `samtykke ${c.consentMethod === "written" ? "(skriftligt)" : "(i HoldLiv)"}` : "uden samtykke"}
                  {c.expiresOn ? ` · gælder til ${longDate(c.expiresOn)}` : ""}
                </span>
              </span>
              <span className={c.state === "valid" ? "tag paid" : c.state === "expiring" || c.state === "requested" || c.state === "ready_to_request" ? "tag open" : "tag overdue"}>{CERTIFICATE_STATE_LABEL[c.state]}</span>
            </div>
            <div className="row">
              {c.status === "needed" && !c.consentAt && (
                <form action={certificateStepAction}>
                  <input type="hidden" name="clubId" value={klub} />
                  <input type="hidden" name="certificateId" value={c.id} />
                  <button name="step" value="written">
                    Vi har skriftligt samtykke
                  </button>
                </form>
              )}
              {c.status === "needed" && c.consentAt && (
                <form action={certificateStepAction}>
                  <input type="hidden" name="clubId" value={klub} />
                  <input type="hidden" name="certificateId" value={c.id} />
                  <button className="primary" name="step" value="requested">
                    Jeg har bestilt den hos Politiet
                  </button>
                </form>
              )}
              {c.status === "requested" && (
                <>
                  <form action={certificateStepAction} className="stack">
                    <input type="hidden" name="clubId" value={klub} />
                    <input type="hidden" name="certificateId" value={c.id} />
                    <div className="row">
                      <label>
                        Attestens dato
                        <input type="date" name="issuedOn" defaultValue={today} max={today} />
                      </label>
                      <label>
                        Ny attest senest
                        <input type="date" name="expiresOn" defaultValue={suggestExpiry(today)} min={addDays(today, 1)} />
                      </label>
                    </div>
                    <button className="primary" name="step" value="approved">
                      Godkendt, uden anmærkning
                    </button>
                  </form>
                  <form action={certificateStepAction}>
                    <input type="hidden" name="clubId" value={klub} />
                    <input type="hidden" name="certificateId" value={c.id} />
                    <button name="step" value="not_approved">
                      Kan ikke godkendes
                    </button>
                  </form>
                </>
              )}
              {(c.state === "expired" || c.state === "not_approved") && (
                <form action={requireCertificateAction}>
                  <input type="hidden" name="clubId" value={klub} />
                  <input type="hidden" name="profileId" value={c.profileId} />
                  <button className="primary">Start ny attest</button>
                </form>
              )}
              <form action={certificateStepAction}>
                <input type="hidden" name="clubId" value={klub} />
                <input type="hidden" name="certificateId" value={c.id} />
                <button name="step" value="remove" className="link small">
                  Fjern
                </button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
