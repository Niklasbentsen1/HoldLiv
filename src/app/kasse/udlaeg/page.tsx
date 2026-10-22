import Link from "next/link";
import { EXPENSE_STATUS_LABEL, getMileageRate, listExpenses, type ExpenseFilter, type ExpenseStatus } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { kr, longDate } from "../../../lib/money";
import { ErrorBox } from "../../../components/Shell";
import { KasseShell, NoAccess, pickFinanceClub } from "../../../components/Kasse";
import { decideExpenseAction, payExpenseAction, saveMileageRate } from "../../actions";

export const dynamic = "force-dynamic";

const FILTERS: { key: ExpenseFilter; label: string }[] = [
  { key: "open", label: "Skal godkendes" },
  { key: "unpaid", label: "Skal betales" },
  { key: "paid", label: "Betalt" },
  { key: "all", label: "Alle" },
];

export default async function ExpensesAdmin({ searchParams }: { searchParams: Promise<{ klub?: string; vis?: string; fejl?: string }> }) {
  const p = await searchParams;
  const { ctx } = await requireSession("/kasse/udlaeg");
  const { clubs, club } = await pickFinanceClub(ctx, p.klub);
  if (!club) return <NoAccess ctx={ctx} />;
  const filter = FILTERS.find((f) => f.key === p.vis)?.key ?? "open";
  const [list, rateOre] = await Promise.all([listExpenses(db, ctx, club.id, filter), getMileageRate(db, club.id)]);
  const total = list.reduce((s, c) => s + c.amountOre, 0);

  return (
    <KasseShell ctx={ctx} clubs={clubs} club={club} tab="/udlaeg">
      <ErrorBox message={p.fejl} />
      <div className="chips">
        {FILTERS.map((f) => (
          <Link key={f.key} href={`/kasse/udlaeg?klub=${club.id}&vis=${f.key}`} className={f.key === filter ? "chip active" : "chip"}>
            {f.label}
          </Link>
        ))}
      </div>
      <p className="muted small">
        {list.length} krav, i alt {kr(total)}
        {filter === "unpaid" && list.length > 0 && (
          <>
            {" "}
            · <a href={`/kasse/udlaeg/eksport?klub=${club.id}`}>Hent som regneark til bankoverførsel</a>
          </>
        )}
      </p>

      <ul className="events compact">
        {list.map((c) => (
          <li key={c.id} className="card stack">
            <div className="spread">
              <span className="title">
                {c.firstName} {c.lastName}
              </span>
              <span className="amount">{kr(c.amountOre)}</span>
            </div>
            <div>{c.description}</div>
            <div className="muted small">
              {c.kind === "mileage" ? `Kørsel, ${(c.kmTenths! / 10).toLocaleString("da-DK")} km à ${kr(c.rateOrePerKm!)}` : "Udlæg"} · {longDate(c.spentOn)}
              {c.teamName ? ` · ${c.teamName}` : ""}
            </div>
            <div className="spread">
              <span className="small">{EXPENSE_STATUS_LABEL[c.status as ExpenseStatus]}</span>
              {c.hasReceipt && (
                <a className="small" href={`/udlaeg/bilag/${c.id}`} target="_blank" rel="noopener">
                  Se kvittering
                </a>
              )}
            </div>
            {c.status === "rejected" && c.rejectReason && <p className="small">Begrundelse: {c.rejectReason}</p>}
            {c.status === "submitted" && (
              <div className="stack">
                <form action={decideExpenseAction}>
                  <input type="hidden" name="clubId" value={club.id} />
                  <input type="hidden" name="claimId" value={c.id} />
                  <input type="hidden" name="decision" value="approve" />
                  <button className="primary">Godkend</button>
                </form>
                <form action={decideExpenseAction} className="inline">
                  <input type="hidden" name="clubId" value={club.id} />
                  <input type="hidden" name="claimId" value={c.id} />
                  <input type="hidden" name="decision" value="reject" />
                  <input name="reason" className="grow" placeholder="Begrundelse for afvisning" required />
                  <button>Afvis</button>
                </form>
                {c.own && <p className="muted small">Det er dit eget krav. En anden admin eller kasserer skal godkende det, hvis der er en.</p>}
              </div>
            )}
            {c.status === "approved" && (
              <form action={payExpenseAction} className="inline">
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="claimId" value={c.id} />
                <input name="note" className="grow" placeholder="Fx overført 3/11 (valgfrit)" />
                <button className="primary">Sæt som betalt</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {list.length === 0 && <p className="muted">Ingen krav her.</p>}

      <h2>Kilometersats</h2>
      <form action={saveMileageRate} className="inline">
        <input type="hidden" name="clubId" value={club.id} />
        <label className="grow">
          Foreningens sats for kørselsgodtgørelse (kr. pr. km) <span className="muted">(tomt = kørsel kan ikke indberettes)</span>
          <input name="rate" inputMode="decimal" defaultValue={rateOre ? (rateOre / 100).toString().replace(".", ",") : ""} placeholder="Fx 3,80" />
        </label>
        <button>Gem</button>
      </form>
      <p className="muted small">Satsen bestemmer foreningen selv. Den gælder nye krav; krav der allerede er sendt, beholder deres sats.</p>
    </KasseShell>
  );
}
