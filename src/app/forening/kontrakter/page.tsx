import Link from "next/link";
import { CONTRACT_KIND_LABEL, CONTRACT_STATUS_LABEL, contractTemplate, listClubContracts, listClubPeople } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { kr, longDate } from "../../../lib/money";
import { ErrorBox, Shell } from "../../../components/Shell";
import { Empty, PageHead } from "../../../components/ui";
import { contractStepAction, editContractAction, newContractAction } from "../../actions";

export const dynamic = "force-dynamic";

const krInput = (ore: number) => (ore / 100).toString().replace(".", ",");

function Fields({ c }: { c?: Awaited<ReturnType<typeof listClubContracts>>[number] }) {
  return (
    <>
      <div className="row">
        <label>
          Titel
          <input name="title" required maxLength={160} defaultValue={c?.title} placeholder="Fx Trænerkontrakt U9" />
        </label>
        <label>
          Slags
          <select name="kind" defaultValue={c?.kind ?? "coach"}>
            {Object.entries(CONTRACT_KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <label>
          Fra
          <input type="date" name="startsOn" required defaultValue={c?.startsOn} />
        </label>
        <label>
          Til <span className="muted">(tomt = løbende)</span>
          <input type="date" name="endsOn" defaultValue={c?.endsOn ?? ""} />
        </label>
        <label>
          Aftalt beløb pr. måned (kr.) <span className="muted">(tomt = ingen betaling)</span>
          <input name="amount" inputMode="decimal" defaultValue={c?.monthlyAmountOre ? krInput(c.monthlyAmountOre) : ""} />
        </label>
      </div>
      <label>
        Tekst
        <textarea name="body" required rows={14} maxLength={20000} defaultValue={c?.body ?? contractTemplate("coach")} />
      </label>
    </>
  );
}

export default async function ClubContracts({ searchParams }: { searchParams: Promise<{ klub?: string; fejl?: string }> }) {
  const { klub, fejl } = await searchParams;
  const { ctx } = await requireSession(`/forening/kontrakter?klub=${klub ?? ""}`);
  if (!klub || !ctx.adminClubs.has(klub)) return <Shell ctx={ctx}>Kun foreningens administratorer har adgang her.</Shell>;
  const [list, people] = await Promise.all([listClubContracts(db, ctx, klub), listClubPeople(db, ctx, klub)]);

  return (
    <Shell active="/forening" ctx={ctx}>
      <PageHead
        back={{ href: "/forening", label: "Forening" }}
        title="Kontrakter"
        sub="Trænerkontrakter, spillerkontrakter og frivilligaftaler. Beløb og tekst bestemmer I selv."
        actions={<Link href={`/forening/attester?klub=${klub}`} className="muted small">Børneattester</Link>}
      />
      <ErrorBox message={fejl} />

      <details className="card">
        <summary className="title">Ny kontrakt</summary>
        <form action={newContractAction} className="stack">
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
          <Fields />
          <p className="muted small">Skabelonen er kun et udgangspunkt uden beløb. Ret den, og lad gerne en jurist se den. Underskriften er en enkel accept med navn, ikke MitID.</p>
          <button className="primary">Gem som kladde</button>
        </form>
      </details>

      {list.length === 0 && <Empty icon="edit">Ingen kontrakter endnu.</Empty>}
      <ul className="events">
        {list.map((c) => (
          <li key={c.id} className="card stack">
            <div className="spread">
              <span className="grow">
                <strong className="block">{c.title}</strong>
                <span className="muted small block">
                  {c.name} · {CONTRACT_KIND_LABEL[c.kind]} · fra {longDate(c.startsOn)}
                  {c.endsOn ? ` til ${longDate(c.endsOn)}` : ""}
                  {c.monthlyAmountOre ? ` · ${kr(c.monthlyAmountOre)} om måneden` : ""}
                </span>
              </span>
              <span className={c.status === "signed" ? "tag paid" : c.status === "sent" ? "tag open" : "tag"}>{c.expired ? "Udløbet" : c.expiresSoon ? "Udløber snart" : CONTRACT_STATUS_LABEL[c.status]}</span>
            </div>
            {c.status === "signed" && <div className="muted small">Underskrevet af {c.signedName}.</div>}
            {c.status === "declined" && <div className="muted small">Afvist{c.declinedReason ? `: ${c.declinedReason}` : ""}.</div>}
            <details>
              <summary className="small">{c.status === "draft" ? "Ret kladde" : "Se teksten"}</summary>
              {c.status === "draft" ? (
                <form action={editContractAction} className="stack">
                  <input type="hidden" name="clubId" value={klub} />
                  <input type="hidden" name="contractId" value={c.id} />
                  <Fields c={c} />
                  <button>Gem</button>
                </form>
              ) : (
                <p style={{ whiteSpace: "pre-wrap" }}>{c.body}</p>
              )}
            </details>
            <div className="row">
              {c.status === "draft" && (
                <>
                  <form action={contractStepAction}>
                    <input type="hidden" name="clubId" value={klub} />
                    <input type="hidden" name="contractId" value={c.id} />
                    <button className="primary" name="step" value="send">
                      Send til underskrift
                    </button>
                  </form>
                  <form action={contractStepAction}>
                    <input type="hidden" name="clubId" value={klub} />
                    <input type="hidden" name="contractId" value={c.id} />
                    <button name="step" value="delete">
                      Slet kladde
                    </button>
                  </form>
                </>
              )}
              {(c.status === "sent" || c.status === "signed") && (
                <form action={contractStepAction}>
                  <input type="hidden" name="clubId" value={klub} />
                  <input type="hidden" name="contractId" value={c.id} />
                  <button name="step" value="cancel">
                    Træk tilbage
                  </button>
                </form>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Shell>
  );
}
