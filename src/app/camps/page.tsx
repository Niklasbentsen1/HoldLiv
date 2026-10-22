import Link from "next/link";
import { listCampsForMe } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { kr, longDate } from "../../lib/money";
import { ErrorBox, Shell } from "../../components/Shell";
import { PageHead } from "../../components/ui";
import { cancelCampSignupAction, signUpCampAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function Camps({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx } = await requireSession("/camps");
  const camps = await listCampsForMe(db, ctx);

  return (
    <Shell ctx={ctx} active="/betaling">
      <PageHead title="Camps og arrangementer" sub="Tilmeld dig eller dit barn. Betalingen finder du under Betaling." />
      <ErrorBox message={fejl} />
      {camps.length === 0 && <p className="muted">Der er ingen kommende camps i dine foreninger.</p>}
      <ul className="events">
        {camps.map((c) => (
          <li key={c.id} className="card stack">
            <div className="spread">
              <span className="title">{c.name}</span>
              <span className="amount">{kr(c.priceOre)}</span>
            </div>
            <div className="muted small">
              {longDate(c.startsOn)}
              {c.endsOn !== c.startsOn ? ` – ${longDate(c.endsOn)}` : ""}
            </div>
            {c.description && <p>{c.description}</p>}
            <div className="small">
              {c.cancelledAt
                ? "Aflyst"
                : c.free === null
                  ? "Ubegrænset antal pladser"
                  : c.free > 0 && c.waiting === 0
                    ? `${c.free} ${c.free === 1 ? "plads" : "pladser"} ledige`
                    : `Fuldt${c.waiting > 0 ? `, ${c.waiting} på venteliste` : ""}`}
              {c.siblingDiscountPercent > 0 && ` · søskenderabat ${c.siblingDiscountPercent} %`}
              {c.signupDeadline && ` · tilmelding senest ${longDate(c.signupDeadline)}`}
            </div>
            <ul className="people">
              {c.people.map((p) => (
                <li key={p.profileId} className="spread">
                  <span className="grow">
                    {p.self ? "Dig" : p.firstName}
                    {p.status && (
                      <span className="muted small block">
                        {p.status === "confirmed" ? "Du har en plads. Betal under Betaling." : "Du står på ventelisten."}
                        {p.discountPercent > 0 ? ` Søskenderabat ${p.discountPercent} %.` : ""}
                      </span>
                    )}
                  </span>
                  {p.signupId ? (
                    <form action={cancelCampSignupAction}>
                      <input type="hidden" name="signupId" value={p.signupId} />
                      <button>Afmeld</button>
                    </form>
                  ) : c.open ? (
                    <form action={signUpCampAction}>
                      <input type="hidden" name="campId" value={c.id} />
                      <input type="hidden" name="profileId" value={p.profileId} />
                      <button className="primary">{c.free === 0 || c.waiting > 0 ? "Sæt på venteliste" : "Tilmeld"}</button>
                    </form>
                  ) : (
                    <span className="muted small">Lukket</span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="small">
        <Link href="/betaling">Til Betaling</Link>
      </p>
    </Shell>
  );
}
