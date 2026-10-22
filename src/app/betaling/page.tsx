import { listMyCharges, listMySavedCards } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { kr, localDate, longDate } from "../../lib/money";
import { mockPaymentsEnabled } from "../../lib/payments";
import { ErrorBox, Shell } from "../../components/Shell";
import { ChargeTag } from "../../components/Kasse";
import { PageHead } from "../../components/ui";
import { pay, removeCardAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function Payments({ searchParams }: { searchParams: Promise<{ fejl?: string }> }) {
  const { fejl } = await searchParams;
  const { ctx } = await requireSession("/betaling");
  const { open, done } = await listMyCharges(db, ctx);
  const cards = await listMySavedCards(db, ctx);
  const many = ctx.wards.size > 0;

  return (
    <Shell ctx={ctx} active="/betaling">
      <PageHead title="Betaling" sub={`Kontingent og andre opkrævninger fra foreningen${many ? " for dig og dine børn" : ""}.`} />
      <ErrorBox message={fejl} />

      <h2>Skal betales</h2>
      {open.length === 0 && <p className="muted">Du har ingen ubetalte opkrævninger.</p>}
      <ul className="events">
        {open.map((c) => (
          <li key={c.id} className="card stack">
            <div className="meta spread">
              <span>
                {c.clubName}
                {many && <span className="who">{c.isSelf ? "Dig" : c.firstName}</span>}
              </span>
              <ChargeTag status={c.status} overdue={c.overdue} />
            </div>
            <div className="spread">
              <span className="title">{c.description}</span>
              <span className="amount">{kr(c.amountOre)}</span>
            </div>
            <div className="muted small">Betal senest {longDate(c.dueDate)}</div>
            <form action={pay} className="stack">
              <input type="hidden" name="chargeId" value={c.id} />
              {c.autoChargeEnabled && (
                <label className="small">
                  <input name="saveCard" type="checkbox" /> Husk kortet, så ubetalte og fremtidige opkrævninger trækkes automatisk, når de er forfaldne
                </label>
              )}
              <button className="primary">Betal {kr(c.amountOre)}</button>
            </form>
          </li>
        ))}
      </ul>
      {open.length > 0 && <p className="muted small">Du betaler med kort, MobilePay eller Apple Pay. Pengene går direkte til foreningen.</p>}
      {mockPaymentsEnabled() && open.length > 0 && <p className="test-banner">Testtilstand: der trækkes ingen rigtige penge.</p>}

      {cards.length > 0 && (
        <>
          <h2>Gemte kort</h2>
          <ul className="people">
            {cards.map((k) => (
              <li key={k.id} className="spread">
                <span className="grow">
                  {k.clubName}: {k.brand ?? "Kort"} ••••{k.last4 ?? "????"}
                  <span className="muted small block">Forfaldne opkrævninger trækkes automatisk. Du får besked hver gang.</span>
                </span>
                <form action={removeCardAction}>
                  <input type="hidden" name="cardId" value={k.id} />
                  <button>Fjern</button>
                </form>
              </li>
            ))}
          </ul>
        </>
      )}

      {done.length > 0 && (
        <>
          <h2>Tidligere</h2>
          <ul className="people">
            {done.map((c) => (
              <li key={c.id} className="spread">
                <span className="grow">
                  {c.description}
                  <span className="muted small block">
                    {many ? `${c.isSelf ? "Dig" : c.firstName} · ` : ""}
                    {c.paidAt ? `Betalt ${longDate(localDate(c.paidAt))}` : ""}
                  </span>
                </span>
                <span className="amount">{kr(c.amountOre)}</span>
                {c.status === "paid" && (
                  <a href={`/betaling/pdf/${c.id}`} target="_blank" className="small">
                    Kvittering (PDF)
                  </a>
                )}
                <ChargeTag status={c.status} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Shell>
  );
}
