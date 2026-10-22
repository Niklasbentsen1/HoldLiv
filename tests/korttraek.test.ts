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
import { mockProvider } from "../src/lib/payments";

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
    expect(await runAutoCharges(db, mockProvider, deliver, day(0))).toEqual({ charged: 0, failed: 0, skipped: 0 });
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

  it("andre kan ikke fjerne mit kort", async () => {
    await card(payerProfile);
    const [c] = await db.select().from(savedCards);
    await expect(removeSavedCard(db, admin, c.id, mockProvider)).rejects.toThrow("Kortet findes ikke");
  });
});
