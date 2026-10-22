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
  /** Betaleren har sagt ja til, at kortet gemmes og bruges til senere opkrævninger. */
  saveCard?: boolean;
}

export interface SavedCardRef {
  customerId: string;
  paymentMethodId: string;
  brand: string | null;
  last4: string | null;
}

/** `uncertain`: svaret fra udbyderen manglede (timeout, netværk, serverfejl), så pengene kan være trukket. Må ikke behandles som en afvisning. */
export type OffSessionResult = { ok: true; paymentIntentId: string } | { ok: false; reason: string; uncertain?: boolean };

export interface PaymentProvider {
  name: "stripe" | "mock";
  createCheckout(req: CheckoutRequest): Promise<{ sessionId: string; url: string }>;
  refund(paymentId: string, connectedAccountId: string | null): Promise<void>;
  /** Efter en betaling med saveCard: det gemte kort (kunde og betalingsmetode hos foreningens Stripe-konto). */
  retrieveSavedCard(sessionId: string, connectedAccountId: string | null): Promise<SavedCardRef | null>;
  /** Trækker et gemt kort uden at betaleren er til stede. Kort, der kræver 3-D Secure, afvises (betaleren betaler selv). */
  chargeSavedCard(req: { chargeId: string; attempt: number; amountOre: number; description: string; card: SavedCardRef; connectedAccountId: string | null }): Promise<OffSessionResult>;
  /** Er opkrævningen allerede betalt hos udbyderen (en tidligere uklar kørsel)? Giver betalingens id. */
  findPaymentForCharge(chargeId: string, connectedAccountId: string | null): Promise<string | null>;
  /** Fjerner et gemt kort hos udbyderen. */
  removeCard(card: SavedCardRef, connectedAccountId: string | null): Promise<void>;
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
  async retrieveSavedCard() {
    const id = randomBytes(6).toString("hex");
    return { customerId: `cus_test_${id}`, paymentMethodId: `pm_test_${id}`, brand: "visa", last4: "4242" };
  },
  // Et testkort, hvis betalingsmetode indeholder "fail", afvises. Alle andre trækkes uden penge.
  async chargeSavedCard(req) {
    if (req.card.paymentMethodId.includes("fail")) return { ok: false, reason: "Kortet blev afvist" };
    return { ok: true, paymentIntentId: `pi_test_${randomBytes(8).toString("hex")}` };
  },
  async findPaymentForCharge() {
    return null;
  },
  async removeCard() {},
  async connectAccount(existing, baseUrl) {
    return { accountId: existing ?? `acct_test_${randomBytes(6).toString("hex")}`, url: `${baseUrl}/kasse?stripe=klar` };
  },
};

type FetchFn = typeof fetch;

class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

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
  const call = async (path: string, params: Record<string, unknown>, account?: string | null, method: "POST" | "GET" = "POST", idempotencyKey?: string) => {
    const query = method === "GET" && Object.keys(params).length ? `?${formEncode(params).join("&")}` : "";
    const res = await fetchFn(`https://api.stripe.com/v1/${path}${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(account ? { "Stripe-Account": account } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: method === "POST" ? formEncode(params).join("&") : undefined,
    });
    const body = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
    if (!res.ok) throw new StripeError(`Stripe: ${body.error?.message ?? res.status}`, res.status);
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
          payment_intent_data: { metadata: { charge_id: req.chargeId }, ...(req.saveCard ? { setup_future_usage: "off_session" } : {}) },
          ...(req.saveCard ? { customer_creation: "always" } : {}),
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
    async retrieveSavedCard(sessionId, account) {
      const s = (await call(`checkout/sessions/${encodeURIComponent(sessionId)}`, { expand: { 0: "payment_intent.payment_method" } }, account, "GET")) as {
        customer?: string | null;
        payment_intent?: { payment_method?: { id?: string; card?: { brand?: string; last4?: string } } | null } | null;
      };
      const pm = s.payment_intent?.payment_method;
      if (!s.customer || !pm?.id) return null;
      return { customerId: String(s.customer), paymentMethodId: pm.id, brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null };
    },
    async chargeSavedCard(req) {
      try {
        const pi = (await call(
          "payment_intents",
          {
            amount: req.amountOre,
            currency: "dkk",
            customer: req.card.customerId,
            payment_method: req.card.paymentMethodId,
            off_session: "true",
            confirm: "true",
            description: req.description,
            metadata: { charge_id: req.chargeId },
          },
          req.connectedAccountId,
          "POST",
          `autocharge-${req.chargeId}-${req.attempt}`,
        )) as { id: string; status: string };
        return pi.status === "succeeded" ? { ok: true, paymentIntentId: pi.id } : { ok: false, reason: `Betalingen blev ikke gennemført (${pi.status})` };
      } catch (e) {
        // Kun et svar fra Stripe på 4xx (kortet afvist, ugyldige data) er et sikkert nej. Alt andet kan være et træk, vi ikke fik svar på.
        const sure = e instanceof StripeError && e.status >= 400 && e.status < 500 && e.status !== 409 && e.status !== 429;
        return { ok: false, reason: e instanceof Error ? e.message : "Betalingen blev ikke gennemført", uncertain: !sure };
      }
    },
    async findPaymentForCharge(chargeId, account) {
      const r = (await call("payment_intents/search", { query: `metadata['charge_id']:'${chargeId.replace(/[^0-9a-f-]/gi, "")}' AND status:'succeeded'`, limit: 1 }, account, "GET")) as {
        data?: { id: string }[];
      };
      return r.data?.[0]?.id ?? null;
    },
    async removeCard(card, account) {
      await call(`payment_methods/${encodeURIComponent(card.paymentMethodId)}/detach`, {}, account);
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
