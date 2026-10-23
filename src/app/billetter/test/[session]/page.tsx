// Testbetaling for billetter: står i stedet for Stripe Checkout, når STRIPE_SECRET_KEY ikke er sat.
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTicketCheckout } from "../../../../services";
import { db } from "../../../../lib/db";
import { kr } from "../../../../lib/money";
import { mockPaymentsEnabled } from "../../../../lib/payments";
import { Bare, ErrorBox } from "../../../../components/Shell";
import { completeTestTicketPayment } from "../../../actions";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function TestTicketCheckout({ params, searchParams }: { params: Promise<{ session: string }>; searchParams: Promise<{ fejl?: string }> }) {
  if (!mockPaymentsEnabled()) notFound();
  const { session } = await params;
  const { fejl } = await searchParams;
  const c = await getTicketCheckout(db, session);
  if (!c) notFound();
  return (
    <Bare>
      <p className="test-banner">Testbetaling. Her ville Stripe vise kort, MobilePay og Apple Pay. Der trækkes ingen penge.</p>
      <ErrorBox message={fejl} />
      <section className="card checkout">
        <div className="muted">{c.clubName}</div>
        <h1 className="flush">
          {c.quantity} × {c.name}
        </h1>
        <p className="big">{kr(c.amountOre)}</p>
        {c.status === "pending" ? (
          <form action={completeTestTicketPayment} className="stack">
            <input type="hidden" name="session" value={session} />
            <button className="primary">Betal {kr(c.amountOre)}</button>
            <Link href={`/billetter/${c.eventId}`} className="button">
              Fortryd
            </Link>
          </form>
        ) : (
          <p>
            Denne betaling er allerede gennemført. <Link href={`/billetter/ordre/${c.token}`}>Se billetterne</Link>
          </p>
        )}
      </section>
    </Bare>
  );
}
