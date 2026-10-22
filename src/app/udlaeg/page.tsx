import { expenseClubs, expenseTeams, listMyExpenses, EXPENSE_STATUS_LABEL, type ExpenseStatus } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { kr, localDate, longDate } from "../../lib/money";
import { ErrorBox, Shell } from "../../components/Shell";
import { PageHead } from "../../components/ui";
import { cancelExpenseAction, submitExpenseAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function Expenses({ searchParams }: { searchParams: Promise<{ fejl?: string; sendt?: string }> }) {
  const p = await searchParams;
  const { ctx } = await requireSession("/udlaeg");
  const [clubs, mine, myTeams] = await Promise.all([expenseClubs(db, ctx), listMyExpenses(db, ctx), expenseTeams(db, ctx)]);
  const today = localDate(ctx.now);
  const teamsOf = (clubId: string) => myTeams.filter((t) => t.clubId === clubId);

  return (
    <Shell ctx={ctx} active="/udlaeg">
      <PageHead title="Udlæg og kørsel" sub="Har du lagt penge ud til foreningen eller kørt for den, så send det her. Kassereren godkender og betaler det til dig." />
      <ErrorBox message={p.fejl} />
      {p.sendt && <p className="ok">Tak, det er sendt til godkendelse.</p>}

      {clubs.length === 0 && <p className="muted">Du er ikke medlem af en forening endnu.</p>}
      {clubs.map((club) => (
        <section key={club.id} className="stack">
          {clubs.length > 1 && <h2>{club.name}</h2>}
          <details className="card" open={clubs.length === 1}>
            <summary className="title">Nyt udlæg</summary>
            <form action={submitExpenseAction} className="stack">
              <input type="hidden" name="clubId" value={club.id} />
              <input type="hidden" name="kind" value="expense" />
              <label>
                Hvad er det til?
                <input name="description" required maxLength={200} placeholder="Fx bolde til U15" />
              </label>
              <div className="row">
                <label>
                  Beløb (kr.)
                  <input name="amount" required inputMode="decimal" placeholder="450,00" />
                </label>
                <label>
                  Dato
                  <input type="date" name="spentOn" required max={today} defaultValue={today} />
                </label>
              </div>
              {teamsOf(club.id).length > 0 && (
                <label>
                  Hold (valgfrit)
                  <select name="teamId" defaultValue="">
                    <option value="">Ingen bestemt</option>
                    {teamsOf(club.id).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Foto eller PDF af kvitteringen
                <input type="file" name="receipt" required accept="image/jpeg,image/png,image/webp,application/pdf" />
                <span className="muted small block">Højst 6 MB. Billedet skal vise beløb, dato og hvad der er købt.</span>
              </label>
              <button className="primary">Send udlæg</button>
            </form>
          </details>

          <details className="card">
            <summary className="title">Ny kørsel</summary>
            {club.mileageRateOrePerKm ? (
              <form action={submitExpenseAction} className="stack">
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="kind" value="mileage" />
                <label>
                  Hvortil og hvorfor?
                  <input name="description" required maxLength={200} placeholder="Fx udekamp i Odense" />
                </label>
                <div className="row">
                  <label>
                    Kilometer i alt
                    <input name="km" required inputMode="decimal" placeholder="123,4" />
                  </label>
                  <label>
                    Dato
                    <input type="date" name="spentOn" required max={today} defaultValue={today} />
                  </label>
                </div>
                {teamsOf(club.id).length > 0 && (
                  <label>
                    Hold (valgfrit)
                    <select name="teamId" defaultValue="">
                      <option value="">Ingen bestemt</option>
                      {teamsOf(club.id).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <p className="muted small">Foreningens sats er {kr(club.mileageRateOrePerKm)} pr. km. Beløbet regnes ud, når du sender.</p>
                <button className="primary">Send kørsel</button>
              </form>
            ) : (
              <p className="muted">Foreningen har ikke sat en kilometersats endnu. Bed kassereren om at gøre det.</p>
            )}
          </details>
        </section>
      ))}

      <h2>Dine krav</h2>
      {mine.length === 0 && <p className="muted">Du har ikke sendt noget endnu.</p>}
      <ul className="events compact">
        {mine.map((c) => (
          <li key={c.id} className="card stack">
            <div className="spread">
              <span className="title">{c.description}</span>
              <span className="amount">{kr(c.amountOre)}</span>
            </div>
            <div className="muted small">
              {clubs.length > 1 ? `${c.clubName} · ` : ""}
              {c.kind === "mileage" ? `Kørsel, ${(c.kmTenths! / 10).toLocaleString("da-DK")} km` : "Udlæg"} · {longDate(c.spentOn)}
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
            {c.status === "paid" && c.payNote && <p className="muted small">{c.payNote}</p>}
            {c.status === "submitted" && (
              <form action={cancelExpenseAction}>
                <input type="hidden" name="claimId" value={c.id} />
                <button>Træk tilbage</button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </Shell>
  );
}
