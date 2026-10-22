// Automatisk betaling med gemt kort: kun med betalerens eget ja og foreningens tilladelse, højst tre forsøg, besked til betaleren.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { loadAccessContext } from "../src/auth/context";
import {
  registerUser, createClub, createSingleCharge, setAutoCharge, runAutoCharges, saveCardFromCheckout, listMySavedCards, removeSavedCard, startCheckout, completeCheckout,
  MAX_AUTO_ATTEMPTS,
} from "../src/services";
import { charges, clubMemberships, guardianships, payments, profiles, savedCards } from "../src/db/schema";
import { mockProvider, stripeProvider, type PaymentProvider } from "../src/lib/payments";
import { deleteMyAccount, markAutoPaid, setNotificationPref } from "../src/services";

const { db, sql, reset } = testDb();
const day = (n: number) => new Date(Date.UTC(2026, 10, 2 + n, 12));
const sent: { to: string; subject: string }[] = [];
const deliver = { mail: async (to: string, subject: string) => void sent.push({ to, subject }), sms: null, baseUrl: "https://x.test" };
let clubId: string;
let admin: Awaited<ReturnType<typeof loadAccessContext>>;
let payerCtx: Awaited<ReturnType<typeof loadAccessContext>>;
let payerProfile: string;

async function card(profileId: string, method = "pm_ok") {
  await db.insert(savedCards).values({ clubId, payerProfileId: profileId, provider: "mock", customerId: "cus_1", paymentMethodId: method, brand: "visa", last4: "4242", consentAt: day(-5) });
}
async function charge(profileId: string, amountOre = 10_000) {
  const c = await createSingleCharge(db, admin, clubId, profileId, { description: "Kontingent", amountOre, dueDate: "2026-11-01" });
  return c.id;
}
const status = async (id: string) => (await db.select().from(charges).where(eq(charges.id, id)))[0];

beforeAll(async () => {
  await reset();
  const a = await registerUser(db, "admin@kort.test", { firstName: "Ad", lastName: "Min", birthDate: "1970-01-01" });
  clubId = (await createClub(db, await loadAccessContext(db, a.user.id, day(0)), "Kort IF", "kort-if")).id;
  admin = await loadAccessContext(db, a.user.id, day(0));
  const p = await registerUser(db, "pia@kort.test", { firstName: "Pia", lastName: "Betaler", birthDate: "1985-01-01" });
  payerProfile = p.profile.id;
  await db.insert(clubMemberships).values({ clubId, profileId: payerProfile });
  payerCtx = await loadAccessContext(db, p.user.id, day(0));
});
afterAll(async () => {
  await sql.end();
});

describe("automatisk træk", () => {
  it("trækker intet, før foreningen har tilladt det", async () => {
    await card(payerProfile);
    const id = await charge(payerProfile);
    expect(await runAutoCharges(db, mockProvider, deliver, day(0))).toEqual({ charged: 0, failed: 0, skipped: 0, unclear: 0 });
    expect((await status(id)).status).toBe("open");
  });

  it("kun admin/kasserer kan slå det til", async () => {
    await expect(setAutoCharge(db, payerCtx, clubId, true)).rejects.toThrow();
    await setAutoCharge(db, admin, clubId, true);
  });

  it("trækker forfaldne opkrævninger, markerer dem betalt og giver betaleren besked", async () => {
    const r = await runAutoCharges(db, mockProvider, deliver, day(0));
    expect(r).toMatchObject({ charged: 1, failed: 0 });
    const open = await db.select().from(charges).where(eq(charges.status, "paid"));
    expect(open).toHaveLength(1);
    expect(sent.map((m) => m.subject)).toEqual(["Betalt: Kontingent"]);
    const [pay] = await db.select().from(payments).where(eq(payments.chargeId, open[0].id));
    expect(pay).toMatchObject({ auto: true, status: "succeeded" });
    expect(await runAutoCharges(db, mockProvider, deliver, day(0))).toMatchObject({ charged: 0 });
  });

  it("trækker ikke opkrævninger, der ikke er forfaldne endnu", async () => {
    const c = await createSingleCharge(db, admin, clubId, payerProfile, { description: "Senere", amountOre: 5_000, dueDate: "2026-12-24" });
    expect(await runAutoCharges(db, mockProvider, deliver, day(0))).toMatchObject({ charged: 0, failed: 0 });
    expect((await status(c.id)).status).toBe("open");
    await db.update(charges).set({ status: "cancelled" }).where(eq(charges.id, c.id));
  });

  it("et værgekort dækker barnets opkrævning, men ikke en fremmeds", async () => {
    const [kid] = await db.insert(profiles).values({ firstName: "Ib", lastName: "Betaler", birthDate: "2018-01-01" }).returning();
    const [stranger] = await db.insert(profiles).values({ firstName: "Ulla", lastName: "Fremmed", birthDate: "1990-01-01" }).returning();
    await db.insert(clubMemberships).values([{ clubId, profileId: kid.id }, { clubId, profileId: stranger.id }]);
    await db.insert(guardianships).values({ guardianProfileId: payerProfile, childProfileId: kid.id });
    const k = await charge(kid.id, 7_000);
    const s = await charge(stranger.id, 7_000);
    const r = await runAutoCharges(db, mockProvider, deliver, day(1));
    expect(r.charged).toBe(1);
    expect((await status(k)).status).toBe("paid");
    expect((await status(s)).status).toBe("open");
    await db.update(charges).set({ status: "cancelled" }).where(eq(charges.id, s));
  });
});

describe("mislykkede træk", () => {
  it("prøver højst én gang i døgnet og stopper efter tre forsøg", async () => {
    await db.update(savedCards).set({ paymentMethodId: "pm_fail" }).where(eq(savedCards.payerProfileId, payerProfile));
    const id = await charge(payerProfile, 9_000);
    sent.length = 0;
    expect(await runAutoCharges(db, mockProvider, deliver, day(10))).toMatchObject({ failed: 1 });
    expect(await runAutoCharges(db, mockProvider, deliver, day(10))).toMatchObject({ failed: 0, charged: 0 });
    expect(await runAutoCharges(db, mockProvider, deliver, day(11))).toMatchObject({ failed: 1 });
    expect(await runAutoCharges(db, mockProvider, deliver, day(12))).toMatchObject({ failed: 1 });
    expect(await runAutoCharges(db, mockProvider, deliver, day(13))).toMatchObject({ failed: 0 });
    const c = await status(id);
    expect(c).toMatchObject({ status: "open", autoAttempts: MAX_AUTO_ATTEMPTS });
    expect(sent).toHaveLength(3);
    expect(sent[2].subject).toContain("kunne ikke gennemføres");
    // Fejlteksten fra udbyderen vises ikke for betaleren.
    expect(sent.every((m) => !m.subject.includes("afvist"))).toBe(true);
    await db.update(charges).set({ status: "cancelled" }).where(eq(charges.id, id));
  });

  it("to samtidige kørsler trækker kun én gang", async () => {
    await db.update(savedCards).set({ paymentMethodId: "pm_ok" }).where(eq(savedCards.payerProfileId, payerProfile));
    const id = await charge(payerProfile, 4_000);
    const [a, b] = await Promise.all([runAutoCharges(db, mockProvider, deliver, day(20)), runAutoCharges(db, mockProvider, deliver, day(20))]);
    expect(a.charged + b.charged).toBe(1);
    expect(await db.select().from(payments).where(eq(payments.chargeId, id))).toHaveLength(1);
  });
});

describe("voksne børn og uklare svar", () => {
  it("forælderens kort dækker ikke et barn, der er fyldt 18", async () => {
    await db.delete(savedCards);
    await card(payerProfile);
    const [adult] = await db.insert(profiles).values({ firstName: "Voksen", lastName: "Barn", birthDate: "2000-01-01" }).returning();
    const [teen] = await db.insert(profiles).values({ firstName: "Teen", lastName: "Barn", birthDate: "2009-01-01" }).returning();
    await db.insert(clubMemberships).values([{ clubId, profileId: adult.id }, { clubId, profileId: teen.id }]);
    await db.insert(guardianships).values([{ guardianProfileId: payerProfile, childProfileId: adult.id }, { guardianProfileId: payerProfile, childProfileId: teen.id }]);
    const a = await charge(adult.id, 50_000);
    const t = await charge(teen.id, 50_000);
    await runAutoCharges(db, mockProvider, deliver, day(40));
    expect((await status(a)).status).toBe("open");
    expect((await status(t)).status).toBe("paid");
    await db.update(charges).set({ status: "cancelled" }).where(eq(charges.id, a));
  });

  it("et uklart svar markerer ikke som mislykket, sender ingen fejlmail og trækker ikke igen, hvis udbyderen allerede har trukket", async () => {
    await db.delete(savedCards);
    await card(payerProfile);
    const id = await charge(payerProfile, 6_000);
    let drawn = 0;
    const flaky: PaymentProvider = {
      ...mockProvider,
      async chargeSavedCard() {
        drawn++;
        return { ok: false, reason: "timeout", uncertain: true };
      },
      async findPaymentForCharge() {
        return drawn > 0 ? "pi_found" : null;
      },
    };
    sent.length = 0;
    expect(await runAutoCharges(db, flaky, deliver, day(50))).toMatchObject({ unclear: 1, failed: 0, charged: 0 });
    expect(sent).toHaveLength(0);
    expect((await status(id)).status).toBe("open");
    expect(await runAutoCharges(db, flaky, deliver, day(51))).toMatchObject({ charged: 1, failed: 0 });
    expect(drawn).toBe(1);
    expect((await status(id)).status).toBe("paid");
    expect(sent.map((m) => m.subject)).toEqual(["Betalt: Kontingent"]);
  });

  it("hvis intet findes hos udbyderen, trækkes der igen, og en webhook kan lukke et uklart træk", async () => {
    const id = await charge(payerProfile, 6_500);
    const none: PaymentProvider = { ...mockProvider, async chargeSavedCard() { return { ok: false, reason: "netværk", uncertain: true }; } };
    await runAutoCharges(db, none, deliver, day(60));
    expect(await markAutoPaid(db, id, "pi_webhook", day(60))).toBe(true);
    expect(await markAutoPaid(db, id, "pi_webhook", day(60))).toBe(false);
    expect((await status(id)).status).toBe("paid");
    const id2 = await charge(payerProfile, 6_600);
    await runAutoCharges(db, none, deliver, day(61));
    expect(await runAutoCharges(db, mockProvider, deliver, day(62))).toMatchObject({ charged: 1 });
    expect((await status(id2)).status).toBe("paid");
  });

  it("betalt manuelt imens: kortet refunderes automatisk", async () => {
    const id = await charge(payerProfile, 7_700);
    let refunded: string | null = null;
    const racing: PaymentProvider = {
      ...mockProvider,
      async chargeSavedCard(req) {
        await db.update(charges).set({ status: "paid", paidAt: day(70) }).where(eq(charges.id, req.chargeId));
        return { ok: true, paymentIntentId: "pi_race" };
      },
      async refund(paymentId) {
        refunded = paymentId;
      },
    };
    await runAutoCharges(db, racing, deliver, day(70));
    expect(refunded).toBe("pi_race");
    const [p] = await db.select().from(payments).where(eq(payments.chargeId, id));
    expect(p.status).toBe("refunded");
  });

  it("mail ved træk kan ikke slås fra", async () => {
    await setNotificationPref(db, payerCtx, "payment", "mail", false);
    sent.length = 0;
    const id = await charge(payerProfile, 1_100);
    await runAutoCharges(db, mockProvider, deliver, day(80));
    expect(sent.map((m) => m.subject)).toEqual(["Betalt: Kontingent"]);
    expect((await status(id)).status).toBe("paid");
  });
});

describe("Stripe-udbyderen", () => {
  const req = { chargeId: "c1", attempt: 2, amountOre: 5000, description: "x", card: { customerId: "cus_1", paymentMethodId: "pm_1", brand: null, last4: null }, connectedAccountId: "acct_1" };
  it("sender en Idempotency-Key og regner kun et 4xx-svar for et sikkert nej", async () => {
    const headers: Record<string, string>[] = [];
    const respond = (status: number, body: object) => (async (_u: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    expect(await stripeProvider("sk", respond(200, { id: "pi_1", status: "succeeded" })).chargeSavedCard(req)).toEqual({ ok: true, paymentIntentId: "pi_1" });
    expect(headers[0]["Idempotency-Key"]).toBe("autocharge-c1-2");
    expect(await stripeProvider("sk", respond(402, { error: { message: "Kortet blev afvist" } })).chargeSavedCard(req)).toMatchObject({ ok: false, uncertain: false });
    expect(await stripeProvider("sk", respond(500, { error: { message: "Fejl" } })).chargeSavedCard(req)).toMatchObject({ ok: false, uncertain: true });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await stripeProvider("sk", down).chargeSavedCard(req)).toMatchObject({ ok: false, uncertain: true });
  });
});

describe("gemt kort", () => {
  it("kortet gemmes kun, når betaleren selv siger ja ved betalingen, og kan fjernes igen", async () => {
    await db.delete(savedCards);
    const id = await charge(payerProfile, 3_000);
    const noSave = await startCheckout(db, payerCtx, id, mockProvider, "https://x.test");
    const session = noSave.split("/").pop()!;
    await completeCheckout(db, session);
    expect(await saveCardFromCheckout(db, mockProvider, session)).toBeNull();
    expect(await listMySavedCards(db, payerCtx)).toHaveLength(0);

    const id2 = await charge(payerProfile, 3_000);
    const url = await startCheckout(db, payerCtx, id2, mockProvider, "https://x.test", { saveCard: true });
    const session2 = url.split("/").pop()!;
    expect(await saveCardFromCheckout(db, mockProvider, session2)).toBeNull(); // endnu ikke betalt
    await completeCheckout(db, session2);
    expect(await saveCardFromCheckout(db, mockProvider, session2)).toEqual({ last4: "4242" });
    const cards = await listMySavedCards(db, payerCtx);
    expect(cards).toHaveLength(1);

    const id3 = await charge(payerProfile, 2_000);
    await removeSavedCard(db, payerCtx, cards[0].id, mockProvider);
    expect(await listMySavedCards(db, payerCtx)).toHaveLength(0);
    expect(await runAutoCharges(db, mockProvider, deliver, day(30))).toMatchObject({ charged: 0 });
    expect((await status(id3)).status).toBe("open");
  });

  it("når kontoen slettes, frakobles kortet hos udbyderen", async () => {
    const u = await registerUser(db, "slet@kort.test", { firstName: "Slet", lastName: "Mig", birthDate: "1980-01-01" });
    await db.insert(clubMemberships).values({ clubId, profileId: u.profile.id });
    await db.insert(savedCards).values({ clubId, payerProfileId: u.profile.id, provider: "mock", customerId: "cus_x", paymentMethodId: "pm_x", consentAt: day(0) });
    const removed: string[] = [];
    const spy: PaymentProvider = { ...mockProvider, async removeCard(c) { removed.push(c.paymentMethodId); } };
    await deleteMyAccount(db, await loadAccessContext(db, u.user.id, day(0)), "slet@kort.test", spy);
    expect(removed).toEqual(["pm_x"]);
    expect((await db.select().from(savedCards).where(eq(savedCards.paymentMethodId, "pm_x")))[0].removedAt).not.toBeNull();
  });

  it("andre kan ikke fjerne mit kort", async () => {
    await card(payerProfile);
    const [c] = await db.select().from(savedCards);
    await expect(removeSavedCard(db, admin, c.id, mockProvider)).rejects.toThrow("Kortet findes ikke");
  });
});
