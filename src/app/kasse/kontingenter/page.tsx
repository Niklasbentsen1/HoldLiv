import { listFees, previewChargeRun } from "../../../services";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import { INTERVAL_LABEL, kr, localDate, nextPeriod, periodContaining, type FeeInterval } from "../../../lib/money";
import { ErrorBox } from "../../../components/Shell";
import { KasseShell, NoAccess, pickFinanceClub } from "../../../components/Kasse";
import { chargeFee, editFee, newFee, teamFee } from "../../actions";

export const dynamic = "force-dynamic";

const INTERVALS = Object.entries(INTERVAL_LABEL) as [FeeInterval, string][];
const krInput = (ore: number) => (ore / 100).toString().replace(".", ",");

export default async function Fees({ searchParams }: { searchParams: Promise<{ klub?: string; fejl?: string }> }) {
  const p = await searchParams;
  const { ctx } = await requireSession("/kasse/kontingenter");
  const { clubs, club } = await pickFinanceClub(ctx, p.klub);
  if (!club) return <NoAccess ctx={ctx} />;
  const { fees, teams } = await listFees(db, ctx, club.id);
  const today = localDate(ctx.now);
  const active = fees.filter((f) => !f.archivedAt);
  // For hver sats: indeværende og næste periode, og hvor mange der mangler at blive opkrævet.
  const runs = await Promise.all(
    active.map(async (f) => {
      const current = periodContaining(f.interval, today);
      const next = nextPeriod(f.interval, current.start);
      return { feeId: f.id, options: await Promise.all([current.start, next.start].map((d) => previewChargeRun(db, ctx, f.id, d))) };
    }),
  );

  return (
    <KasseShell ctx={ctx} clubs={clubs} club={club} tab="/kontingenter">
      <ErrorBox message={p.fejl} />
      <p className="muted">
        Medlemmer får automatisk holdets kontingent, når de kommer på et hold. Du kan altid ændre det for den enkelte under Medlemmer.
      </p>

      {active.map((f) => {
        const run = runs.find((r) => r.feeId === f.id)!;
        return (
          <section key={f.id} className="card stack">
            <div className="spread">
              <strong>{f.name}</strong>
              <span className="amount">
                {kr(f.amountOre)} {INTERVAL_LABEL[f.interval]}
              </span>
            </div>
            <div className="muted small">{f.members} betalende medlemmer</div>

            <form action={chargeFee} className="stack">
              <input type="hidden" name="clubId" value={club.id} />
              <input type="hidden" name="feeId" value={f.id} />
              <div className="row">
                <label>
                  Opkræv for
                  <select name="period">
                    {run.options.map((o) => (
                      <option key={o.period.start} value={o.period.start}>
                        {o.label} ({o.members.length} mangler)
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Betalingsfrist
                  <input type="date" name="dueDate" min={today} />
                </label>
              </div>
              <button className="primary">Send opkrævning</button>
            </form>
            <p className="muted small">
              Uden frist bliver den 14 dage efter periodens start (eller fra i dag). Kun medlemmer, der ikke allerede er opkrævet for
              perioden, får en opkrævning, så du trygt kan sende igen, når der er kommet nye medlemmer.
            </p>

            <details>
              <summary className="small">Ret kontingent</summary>
              <form action={editFee} className="stack">
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="feeId" value={f.id} />
                <div className="row">
                  <label>
                    Navn
                    <input name="name" defaultValue={f.name} required />
                  </label>
                  <label>
                    Beløb (kr.)
                    <input name="amount" defaultValue={krInput(f.amountOre)} inputMode="decimal" required />
                  </label>
                </div>
                <button>Gem</button>
                <p className="muted small">Et nyt beløb gælder kommende opkrævninger. Allerede sendte opkrævninger ændres ikke.</p>
              </form>
              <form action={editFee}>
                <input type="hidden" name="clubId" value={club.id} />
                <input type="hidden" name="feeId" value={f.id} />
                <input type="hidden" name="archive" value="1" />
                <button className="danger">Arkivér</button>
              </form>
            </details>
          </section>
        );
      })}

      <details className="card">
        <summary>Nyt kontingent</summary>
        <form action={newFee} className="stack">
          <input type="hidden" name="clubId" value={club.id} />
          <label>
            Navn
            <input name="name" required placeholder="Fx Børn under 13 år" />
          </label>
          <div className="row">
            <label>
              Beløb (kr.)
              <input name="amount" required inputMode="decimal" placeholder="650" />
            </label>
            <label>
              Betales
              <select name="interval" defaultValue="half_year">
                {INTERVALS.map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button className="primary">Opret kontingent</button>
        </form>
      </details>

      <h2>Holdenes kontingent</h2>
      <ul className="people">
        {teams.map((t) => (
          <li key={t.id}>
            <form action={teamFee} className="inline grow">
              <input type="hidden" name="clubId" value={club.id} />
              <input type="hidden" name="teamId" value={t.id} />
              <span className="grow">{t.name}</span>
              <select name="feeId" defaultValue={t.defaultFeeId ?? ""} className="grow">
                <option value="">Intet</option>
                {active.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <button>Gem</button>
            </form>
          </li>
        ))}
      </ul>

      {fees.some((f) => f.archivedAt) && (
        <>
          <h2>Arkiverede</h2>
          <ul className="people">
            {fees
              .filter((f) => f.archivedAt)
              .map((f) => (
                <li key={f.id} className="spread">
                  <span className="grow muted">
                    {f.name}, {kr(f.amountOre)} {INTERVAL_LABEL[f.interval]}
                  </span>
                  <form action={editFee}>
                    <input type="hidden" name="clubId" value={club.id} />
                    <input type="hidden" name="feeId" value={f.id} />
                    <input type="hidden" name="archive" value="0" />
                    <button className="mini">Gendan</button>
                  </form>
                </li>
              ))}
          </ul>
        </>
      )}
    </KasseShell>
  );
}
