import Link from "next/link";
import { listCharges, type ChargeFilter } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { kr, localDate, longDate } from "../../../lib/money";
import { ErrorBox } from "../../../components/Shell";
import { ChargeTag, KasseShell, NoAccess, pickFinanceClub } from "../../../components/Kasse";
import { chargeAction } from "../../actions";

export const dynamic = "force-dynamic";

const FILTERS: { key: ChargeFilter; label: string }[] = [
  { key: "open", label: "Ikke betalt" },
  { key: "overdue", label: "Forfaldne" },
  { key: "paid", label: "Betalt" },
  { key: "all", label: "Alle" },
];
const VIA = { stripe: "kort/MobilePay", mock: "testbetaling", manual: "registreret af kassereren" } as const;

export default async function Charges({ searchParams }: { searchParams: Promise<{ klub?: string; vis?: string; fejl?: string; oprettet?: string }> }) {
  const p = await searchParams;
  const { ctx } = await requireSession("/kasse/opkraevninger");
  const { clubs, club } = await pickFinanceClub(ctx, p.klub);
  if (!club) return <NoAccess ctx={ctx} />;
  const filter = FILTERS.find((f) => f.key === p.vis)?.key ?? "open";
  const list = await listCharges(db, ctx, club.id, filter);
  const back = `/kasse/opkraevninger?klub=${club.id}&vis=${filter}`;
  const total = list.reduce((s, c) => s + c.amountOre, 0);

  return (
    <KasseShell ctx={ctx} clubs={clubs} club={club} tab="/opkraevninger">
      <ErrorBox message={p.fejl} />
      {p.oprettet !== undefined && (
        <p className="ok">{p.oprettet === "0" ? "Alle var allerede opkrævet for perioden." : `${p.oprettet} opkrævninger er oprettet.`}</p>
      )}
      <div className="chips">
        {FILTERS.map((f) => (
          <Link key={f.key} href={`/kasse/opkraevninger?klub=${club.id}&vis=${f.key}`} className={f.key === filter ? "chip active" : "chip"}>
            {f.label}
          </Link>
        ))}
      </div>
      <p className="muted small">
        {list.length} opkrævninger, i alt {kr(total)}
      </p>

      <ul className="events compact">
        {list.map((c) => (
          <li key={c.id} className="card stack">
            <div className="spread">
              <strong>
                {c.firstName} {c.lastName}
              </strong>
              <span className="amount">{kr(c.amountOre)}</span>
            </div>
            <div className="small spread">
              <span className="muted">
                {c.description} · frist {longDate(c.dueDate)}
              </span>
              <ChargeTag status={c.status} overdue={c.overdue} />
            </div>
            {c.paidAt && (
              <div className="muted small">
                Betalt {longDate(localDate(c.paidAt))}
                {c.paidVia ? `, ${VIA[c.paidVia]}` : ""}
                {c.paymentNote ? ` (${c.paymentNote})` : ""}
              </div>
            )}
            {c.reminderCount > 0 && c.status === "open" && <div className="muted small">{c.reminderCount} rykker sendt</div>}
            {c.status === "open" && (
              <details>
                <summary className="small">Registrér betaling eller annullér</summary>
                <form action={chargeAction} className="inline">
                  <input type="hidden" name="chargeId" value={c.id} />
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="do" value="paid" />
                  <input name="note" placeholder="Fx kontant eller bankoverførsel" />
                  <button className="primary">Betalt</button>
                </form>
                <form action={chargeAction} className="actions">
                  <input type="hidden" name="chargeId" value={c.id} />
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="do" value="cancel" />
                  <button className="danger">Annullér opkrævningen</button>
                </form>
              </details>
            )}
            {c.status === "paid" && (
              <details>
                <summary className="small">Refundér</summary>
                <p className="muted small">
                  {c.paidVia === "stripe"
                    ? "Beløbet sendes tilbage til kortet eller MobilePay via Stripe."
                    : "Betalingen kom uden om HoldLiv. Overfør selv pengene tilbage; her markeres den som refunderet."}
                </p>
                <form action={chargeAction}>
                  <input type="hidden" name="chargeId" value={c.id} />
                  <input type="hidden" name="back" value={back} />
                  <input type="hidden" name="do" value="refund" />
                  <button className="danger">Refundér {kr(c.amountOre)}</button>
                </form>
              </details>
            )}
          </li>
        ))}
      </ul>
    </KasseShell>
  );
}
