import Link from "next/link";
import { listMyContracts, CONTRACT_KIND_LABEL, CONTRACT_STATUS_LABEL } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { localDate, longDate } from "../../lib/money";
import { ErrorBox, Shell } from "../../components/Shell";
import { Empty, PageHead } from "../../components/ui";
import { declineContractAction, signContractAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function Contracts({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx } = await requireSession("/kontrakter");
  const list = await listMyContracts(db, ctx);

  return (
    <Shell ctx={ctx} active="/vagtplan">
      <PageHead title="Kontrakter" sub="Aftaler mellem dig (eller dit barn) og foreningen." actions={<Link href="/vagtplan" className="muted small">Til vagtplanen</Link>} />
      <ErrorBox message={fejl} />
      {list.length === 0 && <Empty icon="edit">Du har ingen kontrakter.</Empty>}
      <ul className="events">
        {list.map((c) => (
          <li key={c.id} className="card stack">
            <div className="spread">
              <span className="title">{c.title}</span>
              <span className={c.status === "signed" ? "tag paid" : c.status === "sent" ? "tag open" : "tag"}>{CONTRACT_STATUS_LABEL[c.status]}</span>
            </div>
            <div className="muted small">
              {CONTRACT_KIND_LABEL[c.kind]}
              {c.self ? "" : ` · ${c.firstName}`}
              {` · fra ${longDate(c.startsOn)}`}
              {c.endsOn ? ` til ${longDate(c.endsOn)}` : ""}
              {c.amountLabel ? ` · ${c.amountLabel}` : ""}
            </div>
            <details open={c.status === "sent"}>
              <summary className="small">Læs kontrakten</summary>
              <p style={{ whiteSpace: "pre-wrap" }}>{c.body}</p>
            </details>
            {c.status === "signed" && (
              <div className="muted small">
                Underskrevet af {c.signedName} {c.signedAt ? `den ${longDate(localDate(c.signedAt))}` : ""}.
              </div>
            )}
            {c.canSign && (
              <>
                <form action={signContractAction} className="stack">
                  <input type="hidden" name="contractId" value={c.id} />
                  <label>
                    Skriv dit fulde navn for at skrive under
                    <input name="name" required autoComplete="name" />
                  </label>
                  <p className="muted small">Navnet er din underskrift på præcis denne tekst. Er personen under 18 år, skriver en forælder under.</p>
                  <button className="primary">Skriv under</button>
                </form>
                <details>
                  <summary className="small">Jeg vil ikke skrive under</summary>
                  <form action={declineContractAction} className="stack">
                    <input type="hidden" name="contractId" value={c.id} />
                    <label>
                      Begrundelse <span className="muted">(valgfri)</span>
                      <input name="reason" maxLength={500} />
                    </label>
                    <button>Afvis kontrakten</button>
                  </form>
                </details>
              </>
            )}
          </li>
        ))}
      </ul>
    </Shell>
  );
}
