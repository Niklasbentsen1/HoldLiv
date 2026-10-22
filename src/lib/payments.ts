// Betalinger via Stripe Connect. Hver forening har sin egen Stripe-konto, og betalingen oprettes
// direkte på foreningens konto, så pengene aldrig går gennem HoldLiv. HoldLiv lægger intet gebyr på.
//
// Uden STRIPE_SECRET_KEY bruges en testbetaling i appen (/betal/test/<id>), som opfører sig
// som Stripe Checkout: man sendes til en betalingsside, og betalingen bekræftes bagefter.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface CheckoutRequest {
  chargeId: string;
  amountOre: number;
  description: string;
  customerEmail?: string | null;
  /** Foreningens Stripe-konto. Påkrævet hos Stripe. */
  connectedAccountId: string | null;
  /** Appens adresse, fx https://holdliv.dk */
  baseUrl: string;
}

export interface PaymentProvider {
  name: "stripe" | "mock";
  createCheckout(req: CheckoutRequest): Promise<{ sessionId: string; url: string }>;
  refund(paymentId: string, connectedAccountId: string | null): Promise<void>;
  /** Opretter foreningens Stripe-konto (første gang) og giver et link til Stripes onboarding. */
  connectAccount(existingAccountId: string | null, baseUrl: string): Promise<{ accountId: string; url: string }>;
}

export const successPath = "/betaling/kvittering";
export const cancelPath = "/betaling";

export const mockProvider: PaymentProvider = {
  name: "mock",
  async createCheckout(req) {
    const sessionId = `test_${randomBytes(12).toString("base64url")}`;
    return { sessionId, url: `${req.baseUrl}/betal/test/${sessionId}` };
  },
  async refund() {},
  async connectAccount(existing, baseUrl) {
    return { accountId: existing ?? `acct_test_${randomBytes(6).toString("hex")}`, url: `${baseUrl}/kasse?stripe=klar` };
  },
};

type FetchFn = typeof fetch;

/** Stripe's API taler form-kodning med nøgler som line_items[0][price_data][currency]. */
export function formEncode(params: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") out.push(...formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export function stripeProvider(secretKey: string, fetchFn: FetchFn = fetch): PaymentProvider {
  const call = async (path: string, params: Record<string, unknown>, account?: string | null) => {
    const res = await fetchFn(`https://api.stripe.com/v1/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(account ? { "Stripe-Account": account } : {}),
      },
      body: formEncode(params).join("&"),
    });
    const body = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
    if (!res.ok) throw new Error(`Stripe: ${body.error?.message ?? res.status}`);
    return body;
  };

  return {
    name: "stripe",
    async createCheckout(req) {
      if (!req.connectedAccountId) throw new Error("Foreningen er ikke koblet til Stripe endnu. Kontakt kassereren.");
      const s = await call(
        "checkout/sessions",
        {
          mode: "payment",
          // Betalingsmetoder (kort, MobilePay, Apple Pay) vælges i foreningens Stripe-indstillinger.
          line_items: { 0: { quantity: 1, price_data: { currency: "dkk", unit_amount: req.amountOre, product_data: { name: req.description } } } },
          customer_email: req.customerEmail ?? undefined,
          client_reference_id: req.chargeId,
          metadata: { charge_id: req.chargeId },
          payment_intent_data: { metadata: { charge_id: req.chargeId } },
          success_url: `${req.baseUrl}${successPath}?session={CHECKOUT_SESSION_ID}`,
          cancel_url: `${req.baseUrl}${cancelPath}`,
          locale: "da",
        },
        req.connectedAccountId,
      );
      return { sessionId: String(s.id), url: String(s.url) };
    },
    async refund(paymentId, account) {
      await call("refunds", { payment_intent: paymentId }, account);
    },
    async connectAccount(existing, baseUrl) {
      const accountId = existing ?? String((await call("accounts", { type: "standard", country: "DK" })).id);
      const link = await call("account_links", {
        account: accountId,
        type: "account_onboarding",
        refresh_url: `${baseUrl}/kasse?stripe=igen`,
        return_url: `${baseUrl}/kasse?stripe=klar`,
      });
      return { accountId, url: String(link.url) };
    },
  };
}

export const mockPaymentsEnabled = () =>
  !process.env.STRIPE_SECRET_KEY && (process.env.NODE_ENV !== "production" || process.env.DEMO_LOGIN === "1");

export function getPaymentProvider(): PaymentProvider {
  const key = process.env.STRIPE_SECRET_KEY;
  if (key) return stripeProvider(key);
  if (!mockPaymentsEnabled()) throw new Error("STRIPE_SECRET_KEY mangler, så der kan ikke tages imod betalinger");
  return mockProvider;
}

/**
 * Tjekker Stripe-Signature-headeren ("t=...,v1=...") på et webhook-kald.
 * Afviser kald ældre end 5 minutter, så et opsnappet kald ikke kan sendes igen senere.
 */
export function verifyStripeSignature(payload: string, header: string | null, secret: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || sigs.length === 0 || Math.abs(now / 1000 - Number(t)) > 300) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex"));
  return sigs.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), expected));
}
