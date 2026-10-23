// Stripe-webhooken for billetkøb: forretningsfejl refunderes, alle andre fejl giver Stripe lov til at prøve igen.
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = "postgres://holdliv:holdliv@localhost:5432/holdliv_test";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";

const complete = vi.fn();
const refund = vi.fn();
vi.mock("../src/services", async (orig) => ({ ...(await orig<typeof import("../src/services")>()), completeTicketOrder: complete, refundFailedTicketPayment: refund }));

const signed = (body: object) => {
  const payload = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", "whsec_test").update(`${t}.${payload}`).digest("hex");
  return new Request("http://test/api/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": `t=${t},v1=${v1}` } }) as never;
};
const event = { type: "checkout.session.completed", data: { object: { id: "cs_1", payment_status: "paid", payment_intent: "pi_9", amount_total: 5000 } } };

beforeEach(() => {
  complete.mockReset();
  refund.mockReset();
});

describe("webhook for billetkøb", () => {
  it("refunderer automatisk ved en forretningsfejl og svarer 200", async () => {
    const { TicketPaymentError } = await import("../src/services");
    const { POST } = await import("../src/app/api/stripe/webhook/route");
    complete.mockRejectedValue(new TicketPaymentError("Bestillingen er annulleret."));
    refund.mockResolvedValue({ orderId: "o", refunded: true });
    const res = await POST(signed(event));
    expect(res.status).toBe(200);
    expect(refund).toHaveBeenCalledOnce();
    expect(refund.mock.calls[0][2]).toBe("cs_1");
    expect(refund.mock.calls[0][3]).toMatchObject({ paymentIntentId: "pi_9" });
  });

  it("lader andre fejl bryde igennem, så Stripe prøver igen, og refunderer ikke", async () => {
    const { POST } = await import("../src/app/api/stripe/webhook/route");
    complete.mockRejectedValue(new Error("Failed query: forbindelsen røg"));
    await expect(POST(signed(event))).rejects.toThrow(/Failed query/);
    expect(refund).not.toHaveBeenCalled();
  });

  it("lader Stripe prøve igen, hvis refusionen fejler", async () => {
    const { TicketPaymentError } = await import("../src/services");
    const { POST } = await import("../src/app/api/stripe/webhook/route");
    complete.mockRejectedValue(new TicketPaymentError("Pladserne er givet videre."));
    refund.mockRejectedValue(new Error("Stripe er nede"));
    await expect(POST(signed(event))).rejects.toThrow(/Stripe er nede/);
  });
});
