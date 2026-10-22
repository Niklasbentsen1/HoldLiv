// Medlemmer, kontingent og betaling mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { charges, clubMemberships, payments } from "../src/db/schema";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import {
  cancelCharge,
  createClub,
  completeCheckout,
  connectPayments,
  createFee,
  createTeam,
  financeOverview,
  grantTreasurerByEmail,
  joinTeamByInvite,
  listCharges,
  listFees,
  listMembers,
  listMyCharges,
  membersCsv,
  previewChargeRun,
  refundCharge,
  registerManualPayment,
  revokeTreasurer,
  runCharges,
  sendReminders,
  setTeamDefaultFee,
  startCheckout,
  updateFee,
  updateMembership,
} from "../src/services";
import { formEncode, mockProvider, stripeProvider, verifyStripeSignature, type PaymentProvider } from "../src/lib/payments";
import { kr, nextPeriod, parseKr, periodContaining, periodLabel } from "../src/lib/money";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
const NOW = new Date("2026-10-22T10:00:00Z");

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db, NOW);
});
afterAll(() => sql.end());

const ctxOf = (key: keyof typeof demo.users, now = NOW) => loadAccessContext(db, demo.users[key].user.id, now);
const BASE = "http://localhost:3000";

describe("beløb og perioder", () => {
  it("regner i øre og skriver danske beløb", () => {
    expect(parseKr("650")).toBe(65000);
    expect(parseKr("1.100,50 kr.")).toBe(110050);
    expect(() => parseKr("seks")).toThrow();
    expect(kr(110050)).toBe("1.100,5 kr.");
  });

  it("følger kalenderens perioder", () => {
    expect(periodContaining("half_year", "2026-10-22")).toEqual({ start: "2026-07-01", end: "2026-12-31" });
    expect(periodContaining("quarter", "2026-02-28")).toEqual({ start: "2026-01-01", end: "2026-03-31" });
    expect(periodContaining("month", "2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(nextPeriod("half_year", "2026-07-01")).toEqual({ start: "2027-01-01", end: "2027-06-30" });
    expect(periodLabel("half_year", "2026-07-01")).toBe("2. halvår 2026");
    expect(periodLabel("month", "2026-10-01")).toBe("oktober 2026");
  });
});

describe("kassereren Sofie", () => {
  it("har adgang til medlemmer og kontingent, men ikke til hold og trænere", async () => {
    const ctx = await ctxOf("sofie");
    expect(ctx.treasurerClubs.has(demo.club.id)).toBe(true);
    expect((await listMembers(db, ctx, demo.club.id)).length).toBeGreaterThan(15);
    await expect(createTeam(db, ctx, demo.club.id, "U13")).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("almindelige medlemmer og trænere kan ikke se økonomien", async () => {
    for (const who of ["mette", "jonas", "ali"] as const) {
      const ctx = await ctxOf(who);
      await expect(listMembers(db, ctx, demo.club.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listCharges(db, ctx, demo.club.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("admin kan også håndtere økonomien", async () => {
    const ctx = await ctxOf("niklas");
    expect((await financeOverview(db, ctx, demo.club.id)).members.active).toBeGreaterThan(15);
  });

  it("medlemslisten viser hold, forældre og hvem der skylder", async () => {
    const ctx = await ctxOf("sofie");
    const all = await listMembers(db, ctx, demo.club.id);
    const emma = all.find((m) => m.profileId === demo.emma.id)!;
    expect(emma.teams).toEqual(["U9 piger"]);
    expect(emma.guardians.map((g) => g.firstName)).toEqual(["Niklas"]);
    expect(emma.feeName).toBe("Børn under 13 år");
    expect(emma.openOre).toBe(65000);
    expect(emma.overdue).toBe(true);
    const overdue = await listMembers(db, ctx, demo.club.id, { filter: "overdue" });
    expect(overdue.map((m) => m.firstName).sort()).toEqual(["Ali", "Emma", "Noor", "Oliver"]);
    expect((await listMembers(db, ctx, demo.club.id, { q: "niklas" })).map((m) => m.firstName).sort()).toEqual(["Emma", "Niklas"]);
  });

  it("trænere er gratister og får ingen opkrævning", async () => {
    const ctx = await ctxOf("sofie");
    const mette = (await listMembers(db, ctx, demo.club.id, { filter: "exempt" })).map((m) => m.firstName);
    expect(mette).toEqual(expect.arrayContaining(["Mette", "Jonas", "Peter"]));
    const mine = await db.select().from(charges).where(eq(charges.profileId, demo.users.mette.profile.id));
    expect(mine).toHaveLength(0);
  });

  it("en opkrævningskørsel kan køres igen uden dobbelte opkrævninger", async () => {
    const ctx = await ctxOf("sofie");
    const preview = await previewChargeRun(db, ctx, demo.fees.kids.id, "2026-10-22");
    expect(preview.members).toHaveLength(0);
    expect(await runCharges(db, ctx, demo.fees.kids.id, "2026-10-22")).toEqual({ created: 0, totalOre: 0, joinFees: 0 });

    // Næste halvår: alle ni børn opkræves, med frist 14 dage efter periodens start.
    const next = await previewChargeRun(db, ctx, demo.fees.kids.id, "2027-01-01");
    expect(next.members).toHaveLength(9);
    expect(next.totalOre).toBe(9 * 65000);
    expect(await runCharges(db, ctx, demo.fees.kids.id, "2027-01-01")).toEqual({ created: 9, totalOre: 9 * 65000, joinFees: 0 });
    const [c] = await db.select().from(charges).where(and(eq(charges.profileId, demo.emma.id), eq(charges.periodStart, "2027-01-01")));
    expect(c.description).toBe("Børn under 13 år, 1. halvår 2027");
    expect(c.dueDate).toBe("2027-01-15");
  });

  it("en prisændring gælder kun kommende opkrævninger", async () => {
    const ctx = await ctxOf("sofie");
    await updateFee(db, ctx, demo.fees.senior.id, { amountOre: 120000 });
    const [old] = await db.select().from(charges).where(and(eq(charges.profileId, demo.users.niklas.profile.id), eq(charges.periodStart, "2026-07-01")));
    expect(old.amountOre).toBe(110000);
  });

  it("foreningen bestemmer selv navn, beløb og interval på alle satser", async () => {
    const ctx = await ctxOf("sofie");
    const fee = await createFee(db, ctx, demo.club.id, { name: "Motion", amountOre: 30000, interval: "quarter" });
    const updated = await updateFee(db, ctx, fee.id, { name: "Motion og fitness", amountOre: 125050, interval: "year" });
    expect(updated).toMatchObject({ name: "Motion og fitness", amountOre: 125050, interval: "year" });
    await expect(updateFee(db, await ctxOf("mette"), fee.id, { amountOre: 1 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("udmeldte og gratister kommer ikke med i næste kørsel", async () => {
    const ctx = await ctxOf("sofie");
    await updateMembership(db, ctx, demo.club.id, demo.users.henrik.profile.id, { status: "inactive" });
    await updateMembership(db, ctx, demo.club.id, demo.users.lars.profile.id, { exempt: true });
    const preview = await previewChargeRun(db, ctx, demo.fees.senior.id, "2027-01-01");
    expect(preview.members.map((m) => m.firstName).sort()).toEqual(["Ali", "Niklas"]);
    const inactive = await listMembers(db, ctx, demo.club.id, { filter: "inactive" });
    expect(inactive.map((m) => m.firstName)).toEqual(["Henrik"]);
  });

  it("kan ikke give et kontingent fra en anden forening og har ingen adgang dér", async () => {
    const other = await createClub(db, await ctxOf("peter"), "Nabo IF", "nabo-if");
    const peterFee = await createFee(db, await ctxOf("peter"), other.id, { name: "Nabo", amountOre: 100, interval: "year" });
    const sofie = await ctxOf("sofie");
    await expect(updateMembership(db, sofie, demo.club.id, demo.emma.id, { feeId: peterFee.id })).rejects.toThrow(/anden forening/);
    await expect(listMembers(db, sofie, other.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("registrerer en kontant betaling og kan refundere den", async () => {
    const ctx = await ctxOf("sofie");
    const [c] = (await listCharges(db, ctx, demo.club.id, "overdue")).filter((x) => x.profileId === demo.kids.oliver.id);
    await registerManualPayment(db, ctx, c.id, "Kontant ved træning");
    await expect(registerManualPayment(db, ctx, c.id, null)).rejects.toThrow(/ikke åben/);
    const paid = (await listCharges(db, ctx, demo.club.id, "paid")).find((x) => x.id === c.id)!;
    expect(paid.paidVia).toBe("manual");
    expect(paid.paymentNote).toBe("Kontant ved træning");
    await refundCharge(db, ctx, c.id, mockProvider);
    const [after] = await db.select().from(charges).where(eq(charges.id, c.id));
    expect(after.status).toBe("refunded");
  });

  it("kan annullere en åben opkrævning", async () => {
    const ctx = await ctxOf("sofie");
    const c = (await listCharges(db, ctx, demo.club.id, "open")).find((x) => x.description.includes("Træningstrøje"))!;
    await cancelCharge(db, ctx, c.id);
    expect((await listCharges(db, ctx, demo.club.id, "open")).some((x) => x.id === c.id)).toBe(false);
  });

  it("sender rykker til forældrene, højst én gang om ugen", async () => {
    const ctx = await ctxOf("sofie");
    const sent: { to: string; subject: string }[] = [];
    const mail = async (to: string, subject: string) => void sent.push({ to, subject });
    const r = await sendReminders(db, ctx, demo.club.id, mail, BASE);
    expect(r.sent).toBe(3); // Emma, Noor og Ali (Oliver er betalt).
    expect(sent.find((s) => s.subject.includes("Emma"))?.to).toBe("niklas@holdliv.test");
    expect(sent.find((s) => s.subject.includes("Noor"))?.to).toBe("ali@holdliv.test");
    expect((await sendReminders(db, ctx, demo.club.id, mail, BASE)).sent).toBe(0);
    const later = await ctxOf("sofie", new Date(NOW.getTime() + 8 * 86_400_000));
    expect((await sendReminders(db, later, demo.club.id, mail, BASE)).sent).toBe(3);
  });

  it("medlemslisten kan hentes som regneark", async () => {
    const csv = await membersCsv(db, await ctxOf("sofie"), demo.club.id);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toContain("Fornavn;Efternavn");
    expect(lines.find((l) => l.startsWith("Emma;"))).toContain("Niklas Bentsen");
  });

  it("admin udpeger og fjerner kassereren; kassereren kan ikke selv udpege flere", async () => {
    const karen = await ctxOf("karen");
    const sofie = await ctxOf("sofie");
    await expect(grantTreasurerByEmail(db, sofie, demo.club.id, "anne@holdliv.test")).rejects.toBeInstanceOf(ForbiddenError);
    await grantTreasurerByEmail(db, karen, demo.club.id, "anne@holdliv.test");
    expect((await ctxOf("anne")).treasurerClubs.has(demo.club.id)).toBe(true);
    await revokeTreasurer(db, karen, demo.club.id, demo.users.anne.profile.id);
    expect((await ctxOf("anne")).treasurerClubs.size).toBe(0);
  });
});

describe("holdets standardkontingent", () => {
  it("nye spillere får holdets kontingent, men et valgt kontingent røres ikke", async () => {
    const sofie = await ctxOf("sofie");
    const fees = await listFees(db, sofie, demo.club.id);
    expect(fees.teams.find((t) => t.id === demo.teams.u9.id)?.defaultFeeId).toBe(demo.fees.kids.id);

    const karen = await ctxOf("karen");
    const u13 = await createTeam(db, karen, demo.club.id, "U13 piger");
    const u13Fee = await createFee(db, sofie, demo.club.id, { name: "U13", amountOre: 75000, interval: "half_year" });
    await setTeamDefaultFee(db, sofie, u13.id, u13Fee.id);

    // Emma har allerede et kontingent og beholder det. William (ny i foreningen via et barn) ville få U13.
    await joinTeamByInvite(db, await ctxOf("niklas"), u13.inviteCode, demo.emma.id);
    const [emma] = await db.select().from(clubMemberships).where(eq(clubMemberships.profileId, demo.emma.id));
    expect(emma.feeId).toBe(demo.fees.kids.id);

    await updateMembership(db, sofie, demo.club.id, demo.kids.ida.id, { feeId: null });
    await joinTeamByInvite(db, await ctxOf("sofie"), u13.inviteCode, demo.kids.ida.id);
    const [ida] = await db.select().from(clubMemberships).where(eq(clubMemberships.profileId, demo.kids.ida.id));
    expect(ida.feeId).toBe(u13Fee.id);
  });
});

describe("forælderen Niklas betaler for Emma", () => {
  it("ser Emmas og sine egne opkrævninger", async () => {
    const { open } = await listMyCharges(db, await ctxOf("niklas"));
    const emmaOpen = open.filter((c) => c.profileId === demo.emma.id);
    expect(emmaOpen.length).toBeGreaterThan(0);
    expect(emmaOpen[0].overdue).toBe(true);
  });

  it("betaler via betalingssiden, og opkrævningen bliver betalt én gang", async () => {
    const ctx = await ctxOf("niklas");
    const { open } = await listMyCharges(db, ctx);
    const charge = open.find((c) => c.profileId === demo.emma.id && c.description.includes("2. halvår 2026"))!;
    const url = await startCheckout(db, ctx, charge.id, mockProvider, BASE);
    expect(url).toMatch(/^http:\/\/localhost:3000\/betal\/test\/test_/);
    const sessionId = url.split("/").pop()!;
    // Betalingen er ikke gennemført, før den bekræftes.
    expect((await db.select().from(charges).where(eq(charges.id, charge.id)))[0].status).toBe("open");

    expect(await completeCheckout(db, sessionId, { amountOre: 65000 })).toEqual({ chargeId: charge.id, alreadyDone: false });
    expect(await completeCheckout(db, sessionId)).toEqual({ chargeId: charge.id, alreadyDone: true });
    const [paid] = await db.select().from(charges).where(eq(charges.id, charge.id));
    expect(paid.status).toBe("paid");
    await expect(startCheckout(db, ctx, charge.id, mockProvider, BASE)).rejects.toThrow(/allerede betalt/);
  });

  it("afviser en bekræftelse med forkert beløb", async () => {
    const ctx = await ctxOf("niklas");
    const { open } = await listMyCharges(db, ctx);
    const url = await startCheckout(db, ctx, open[0].id, mockProvider, BASE);
    await expect(completeCheckout(db, url.split("/").pop()!, { amountOre: 1 })).rejects.toThrow(/beløb/);
  });

  it("andre kan ikke betale eller se Emmas opkrævninger", async () => {
    const jonas = await ctxOf("jonas");
    const [c] = await db.select().from(charges).where(eq(charges.profileId, demo.emma.id));
    await expect(startCheckout(db, jonas, c.id, mockProvider, BASE)).rejects.toBeInstanceOf(ForbiddenError);
    const { open, done } = await listMyCharges(db, jonas);
    expect([...open, ...done].some((x) => x.profileId === demo.emma.id)).toBe(false);
  });
});

describe("Stripe", () => {
  it("koder parametre som Stripe forventer", () => {
    expect(formEncode({ line_items: { 0: { price_data: { unit_amount: 65000 } } }, x: undefined, mode: "payment" })).toEqual([
      "line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=65000",
      "mode=payment",
    ]);
  });

  it("opretter betalingen på foreningens egen konto i danske kroner", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/cs_test_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const stripe = stripeProvider("sk_test_x", fake);
    await expect(stripe.createCheckout({ chargeId: "c1", amountOre: 65000, description: "x", connectedAccountId: null, baseUrl: BASE })).rejects.toThrow(/ikke koblet/);
    const r = await stripe.createCheckout({ chargeId: "c1", amountOre: 65000, description: "Kontingent", connectedAccountId: "acct_1", baseUrl: BASE });
    expect(r).toEqual({ sessionId: "cs_test_1", url: "https://checkout.stripe.com/c/cs_test_1" });
    const { url, init } = calls[0];
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((init.headers as Record<string, string>)["Stripe-Account"]).toBe("acct_1");
    const body = decodeURIComponent(String(init.body));
    expect(body).toContain("line_items[0][price_data][currency]=dkk");
    expect(body).toContain("line_items[0][price_data][unit_amount]=65000");
    expect(body).toContain("metadata[charge_id]=c1");
    expect(body).not.toContain("application_fee");
  });

  it("godkender kun webhooks med gyldig og frisk signatur", () => {
    const secret = "whsec_test";
    const payload = '{"type":"checkout.session.completed"}';
    const t = Math.floor(NOW.getTime() / 1000);
    const sig = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
    expect(verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret, NOW.getTime())).toBe(true);
    expect(verifyStripeSignature(payload + " ", `t=${t},v1=${sig}`, secret, NOW.getTime())).toBe(false);
    expect(verifyStripeSignature(payload, `t=${t},v1=${sig}`, "whsec_other", NOW.getTime())).toBe(false);
    expect(verifyStripeSignature(payload, `t=${t},v1=${sig}`, secret, NOW.getTime() + 10 * 60_000)).toBe(false);
    expect(verifyStripeSignature(payload, null, secret)).toBe(false);
  });

  it("refunderer kortbetalinger via foreningens Stripe-konto", async () => {
    const refunds: string[] = [];
    const provider: PaymentProvider = { ...mockProvider, name: "stripe", refund: async (id, acct) => void refunds.push(`${id}@${acct}`) };
    const sofie = await ctxOf("sofie");
    await connectPayments(db, sofie, demo.club.id, mockProvider, BASE);
    const overview = await financeOverview(db, sofie, demo.club.id);
    expect(overview.paymentsConnected).toBe(true);

    const ali = await ctxOf("ali");
    const [c] = await db.select().from(charges).where(and(eq(charges.profileId, demo.kids.noor.id), eq(charges.status, "open")));
    const url = await startCheckout(db, ali, c.id, provider, BASE);
    await completeCheckout(db, url.split("/").pop()!, { paymentIntentId: "pi_123" });
    await refundCharge(db, sofie, c.id, provider);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatch(/^pi_123@acct_test_/);
    const [p] = await db.select().from(payments).where(eq(payments.providerPaymentId, "pi_123"));
    expect(p.status).toBe("refunded");
  });
});
