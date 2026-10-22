// Stripe kalder denne adresse, når en betaling er gennemført. Opsæt den i Stripe som
// Connect-webhook (hændelser fra foreningernes konti) med checkout.session.completed.
import { NextResponse, type NextRequest } from "next/server";
import { completeCheckout, markAutoPaid, saveCardFromCheckout } from "../../../../services";
import { db } from "../../../../lib/db";
import { getPaymentProvider, verifyStripeSignature } from "../../../../lib/payments";

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "STRIPE_WEBHOOK_SECRET mangler" }, { status: 500 });
  const payload = await req.text();
  if (!verifyStripeSignature(payload, req.headers.get("stripe-signature"), secret)) {
    return NextResponse.json({ error: "Ugyldig signatur" }, { status: 400 });
  }
  const event = JSON.parse(payload) as {
    type: string;
    data: { object: { id: string; payment_status?: string; payment_intent?: string | null; amount_total?: number | null; metadata?: { charge_id?: string } | null } };
  };
  // Asynkrone betalingsmetoder melder "paid" senere med async_payment_succeeded.
  const done =
    (event.type === "checkout.session.completed" && event.data.object.payment_status === "paid") ||
    event.type === "checkout.session.async_payment_succeeded";
  // Et automatisk træk, hvor vi ikke fik svar fra Stripe: her kommer svaret.
  if (event.type === "payment_intent.succeeded" && event.data.object.metadata?.charge_id) {
    await markAutoPaid(db, event.data.object.metadata.charge_id, event.data.object.id);
  }
  if (done) {
    const s = event.data.object;
    try {
      await completeCheckout(db, s.id, { paymentIntentId: s.payment_intent, amountOre: s.amount_total });
    } catch (e) {
      // Ukendte sessioner (fx fra en anden app på samme Stripe-konto) kvitteres, så Stripe ikke prøver igen.
      if (e instanceof Error && e.message === "Ukendt betaling") return NextResponse.json({ ignored: true });
      throw e;
    }
    // Et kort, der ikke kan gemmes, må ikke få Stripe til at gentage hele kaldet; betalingen er allerede registreret.
    try {
      await saveCardFromCheckout(db, getPaymentProvider(), s.id);
    } catch (e) {
      console.error("Kortet kunne ikke gemmes", e);
    }
  }
  return NextResponse.json({ received: true });
}
