// Testbetaling: står i stedet for Stripe Checkout, når STRIPE_SECRET_KEY ikke er sat.
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCheckout } from "../../../../services";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import { kr } from "../../../../lib/money";
import { mockPaymentsEnabled } from "../../../../lib/payments";
import { Bare, ErrorBox } from "../../../../components/Shell";
import { completeTestPayment } from "../../../actions";

export const dynamic = "force-dynamic";

export default async function TestCheckout({ params, searchParams }: { params: Promise<{ session: string }>; searchParams: Promise<{ fejl?: string }> }) {
  if (!mockPaymentsEnabled()) notFound();
  const { session } = await params;
  const { fejl } = await searchParams;
  const { ctx } = await requireSession(`/betal/test/${session}`);
  const c = await getCheckout(db, ctx, session).catch(() => null);
  if (!c) notFound();

  return (
    <Bare>
      <p className="test-banner">Testbetaling. Her ville Stripe vise kort, MobilePay og Apple Pay. Der trækkes ingen penge.</p>
      <ErrorBox message={fejl} />
      <section className="card checkout">
        <div className="muted">{c.clubName}</div>
        <h1 className="flush">{c.description}</h1>
        <div className="muted">for {c.firstName}</div>
        <p className="big">{kr(c.amountOre)}</p>
        {c.status === "pending" ? (
          <form action={completeTestPayment} className="stack">
            <input type="hidden" name="session" value={session} />
            <button className="primary">Betal {kr(c.amountOre)}</button>
            <Link href="/betaling" className="button">
              Fortryd
            </Link>
          </form>
        ) : (
          <p>
            Denne betaling er allerede gennemført. <Link href="/betaling">Tilbage</Link>
          </p>
        )}
      </section>
    </Bare>
  );
}
