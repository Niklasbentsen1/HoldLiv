import Link from "next/link";
import { financeOverview, listCharges } from "../../services";
import { db } from "../../lib/db";
import { requireSession } from "../../lib/session";
import { kr, longDate } from "../../lib/money";
import { mockPaymentsEnabled } from "../../lib/payments";
import { ErrorBox } from "../../components/Shell";
import { KasseShell, NoAccess, pickFinanceClub } from "../../components/Kasse";
import { connectStripe, remind } from "../actions";

export const dynamic = "force-dynamic";

type Params = { klub?: string; fejl?: string; rykkere?: string; uden_mail?: string; stripe?: string };

export default async function Kasse({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  const { ctx } = await requireSession("/kasse");
  const { clubs, club } = await pickFinanceClub(ctx, p.klub);
  if (!club) return <NoAccess ctx={ctx} />;
  const [o, overdue] = await Promise.all([financeOverview(db, ctx, club.id), listCharges(db, ctx, club.id, "overdue")]);
  const q = `?klub=${club.id}`;

  return (
    <KasseShell ctx={ctx} clubs={clubs} club={club} tab="">
      <ErrorBox message={p.fejl} />
      {p.rykkere !== undefined && (
        <p className="ok">
          {p.rykkere === "0" ? "Der var ingen rykkere at sende. Hver opkrævning får højst én rykker om ugen." : `${p.rykkere} rykkere er sendt.`}
          {p.uden_mail ? ` Mangler e-mail: ${p.uden_mail}.` : ""}
        </p>
      )}
      {p.stripe === "klar" && <p className="ok">Foreningen er koblet til Stripe.</p>}

      <div className="kpis">
        <Link href={`/kasse/medlemmer${q}`} className="kpi">
          <strong>{o.members.active}</strong>
          <span>aktive medlemmer, heraf {o.members.exempt} gratister</span>
        </Link>
        <Link href={`/kasse/medlemmer${q}&vis=no_fee`} className={o.members.noFee ? "kpi warn" : "kpi"}>
          <strong>{o.members.noFee}</strong>
          <span>mangler kontingent</span>
        </Link>
        <Link href={`/kasse/opkraevninger${q}`} className="kpi">
          <strong>{kr(o.charges.openOre)}</strong>
          <span>udestående, {o.charges.openCount} opkrævninger</span>
        </Link>
        <Link href={`/kasse/opkraevninger${q}&vis=overdue`} className={o.charges.overdueCount ? "kpi warn" : "kpi"}>
          <strong>{kr(o.charges.overdueOre)}</strong>
          <span>i restance, {o.charges.overdueCount} opkrævninger</span>
        </Link>
        <div className="kpi">
          <strong>{kr(o.charges.paidYearOre)}</strong>
          <span>betalt i år</span>
        </div>
      </div>

      <h2>Restance</h2>
      {overdue.length === 0 ? (
        <p className="muted">Alle har betalt til tiden.</p>
      ) : (
        <>
          <ul className="people">
            {overdue.slice(0, 10).map((c) => (
              <li key={c.id} className="spread">
                <span className="grow">
                  {c.firstName} {c.lastName}
                  <span className="muted small block">
                    {c.description} · frist {longDate(c.dueDate)}
                    {c.reminderCount ? ` · ${c.reminderCount} rykker${c.reminderCount > 1 ? "e" : ""}` : ""}
                  </span>
                </span>
                <span className="amount">{kr(c.amountOre)}</span>
              </li>
            ))}
          </ul>
          {overdue.length > 10 && (
            <p className="small">
              <Link href={`/kasse/opkraevninger${q}&vis=overdue`}>Se alle {overdue.length}</Link>
            </p>
          )}
          <form action={remind} className="actions">
            <input type="hidden" name="clubId" value={club.id} />
            <button className="primary">Send rykker på mail</button>
          </form>
          <p className="muted small">Forældrene får rykkeren for børn under 18. Højst én rykker pr. opkrævning om ugen.</p>
        </>
      )}

      <h2>Betalinger</h2>
      <section className="card stack">
        {o.paymentsConnected ? (
          <p className="flush">
            Foreningen er koblet til Stripe. Medlemmerne betaler med kort eller MobilePay, og pengene går direkte til foreningens egen konto.
            HoldLiv tager intet gebyr; Stripes eget gebyr trækkes af beløbet.
          </p>
        ) : (
          <>
            <p className="flush">
              Kobl foreningen til Stripe, så medlemmerne kan betale med kort og MobilePay. Pengene går direkte til foreningens egen konto, og
              HoldLiv tager intet gebyr. Indtil da kan du registrere betalinger, der kommer ind på anden vis.
            </p>
            <form action={connectStripe}>
              <input type="hidden" name="clubId" value={club.id} />
              <button className="primary">Kobl til Stripe</button>
            </form>
          </>
        )}
        {mockPaymentsEnabled() && <p className="test-banner">Testtilstand: betalinger i HoldLiv er ikke rigtige, og der trækkes ingen penge.</p>}
      </section>
    </KasseShell>
  );
}
