// Billetsalg med QR mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { mockProvider } from "../src/lib/payments";
import { withUserScope } from "../src/db/scope";
import { ticketOrders } from "../src/db/schema";
import { eq } from "drizzle-orm";
import {
  admitTicket,
  cancelTicketEvent,
  checkTicket,
  completeTicketOrder,
  createTicketEvent,
  createTicketOrder,
  getPublicSite,
  getPublicTicketEvent,
  getTicketOrder,
  listOpenTicketEvents,
  listTicketEvents,
  listTicketOrders,
  refundTicketOrder,
  saveSiteSettings,
  updateTicketEvent,
  HOLD_MINUTES,
  MAX_ORDERS_PER_IP_PER_HOUR,
} from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
let clubId: string;
const mails: { to: string; subject: string; text: string }[] = [];
const mail = async (to: string, subject: string, text: string) => {
  mails.push({ to, subject, text });
};
const BASE = "http://test";
const DAY = 86_400_000;

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
  clubId = demo.club.id;
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const input = (over: Partial<Parameters<typeof createTicketEvent>[3]> = {}) => ({ name: "Hjemmekamp", startsAt: new Date(Date.now() + 3 * DAY), priceOre: 5000, capacity: 5, ...over });
const buy = (eventId: string, quantity = 1, email = "gaest@example.test", now = new Date(), ip: string | null = null) =>
  createTicketOrder(db, eventId, { name: "Gæst Gæstesen", email, quantity, acceptTerms: true }, mockProvider, BASE, mail, now, ip);
const pay = async (orderToken: string, now = new Date()) => {
  const [o] = await db.select().from(ticketOrders).where(eq(ticketOrders.accessToken, orderToken));
  return completeTicketOrder(db, o.providerRef!, { amountOre: o.amountOre, now });
};

describe("oprettelse og priser", () => {
  it("lader kun admin og kasserer styre billetsalg, og foreningen sætter selv prisen", async () => {
    for (const k of ["mette", "ali"] as const) await expect(createTicketEvent(db, await ctxOf(k), clubId, input())).rejects.toBeInstanceOf(ForbiddenError);
    const karen = await ctxOf("karen");
    await expect(createTicketEvent(db, karen, clubId, input({ name: " " }))).rejects.toThrow(/navn/);
    await expect(createTicketEvent(db, karen, clubId, input({ priceOre: -1 }))).rejects.toThrow(/Prisen/);
    await expect(createTicketEvent(db, karen, clubId, input({ capacity: 0 }))).rejects.toThrow(/pladser/);
    await expect(createTicketEvent(db, karen, clubId, input({ saleClosesAt: new Date(Date.now() + 9 * DAY) }))).rejects.toThrow(/lukke/);
    await expect(createTicketEvent(db, karen, clubId, input({ eventId: "00000000-0000-0000-0000-000000000000" }))).rejects.toThrow(/Aktiviteten/);
    const e = await createTicketEvent(db, karen, clubId, input({ priceOre: 7500 }));
    expect((await getPublicTicketEvent(db, e.id))!.priceOre).toBe(7500);
    await updateTicketEvent(db, karen, e.id, input({ priceOre: 9000 }));
    expect((await getPublicTicketEvent(db, e.id))!.priceOre).toBe(9000);
  });
});

describe("køb uden login", () => {
  let eventId: string;
  beforeAll(async () => {
    eventId = (await createTicketEvent(db, await ctxOf("karen"), clubId, input({ name: "Fest", capacity: 5 }))).id;
  });

  it("validerer køberen", async () => {
    await expect(createTicketOrder(db, eventId, { name: "", email: "a@b.dk", quantity: 1, acceptTerms: true }, mockProvider, BASE, mail)).rejects.toThrow(/navn/);
    await expect(createTicketOrder(db, eventId, { name: "A", email: "ikke-en-mail", quantity: 1, acceptTerms: true }, mockProvider, BASE, mail)).rejects.toThrow(/e-mail/);
    await expect(createTicketOrder(db, eventId, { name: "A", email: "a@b.dk", quantity: 0, acceptTerms: true }, mockProvider, BASE, mail)).rejects.toThrow(/mindst én/);
    await expect(createTicketOrder(db, eventId, { name: "A", email: "a@b.dk", quantity: 1, acceptTerms: false }, mockProvider, BASE, mail)).rejects.toThrow(/acceptere/);
    await expect(buy(eventId, 11)).rejects.toThrow(/højst 10/);
    await expect(buy("ikke-et-id")).rejects.toThrow(/findes ikke/);
  });

  it("holder pladserne under betaling og udsteder billetter først ved betaling", async () => {
    const r = await buy(eventId, 2, "k1@example.test");
    expect(r.redirectUrl).toContain("/billetter/test/");
    expect((await getPublicTicketEvent(db, eventId))!.remaining).toBe(3);
    let order = (await getTicketOrder(db, r.orderToken))!;
    expect(order.status).toBe("pending");
    expect(order.tickets).toHaveLength(0);
    expect(order.amountOre).toBe(10000);

    const done = await pay(r.orderToken);
    expect(done!.alreadyDone).toBe(false);
    order = (await getTicketOrder(db, r.orderToken))!;
    expect(order.status).toBe("paid");
    expect(order.tickets).toHaveLength(2);
    expect(new Set(order.tickets.map((t) => t.code)).size).toBe(2);
    // Anden betaling af samme session gør ingenting.
    expect((await pay(r.orderToken))!.alreadyDone).toBe(true);
    expect((await getTicketOrder(db, r.orderToken))!.tickets).toHaveLength(2);
    expect(await completeTicketOrder(db, "ukendt-session")).toBeNull();
  });

  it("afviser forkert beløb", async () => {
    const r = await buy(eventId, 1, "k2@example.test");
    const [o] = await db.select().from(ticketOrders).where(eq(ticketOrders.accessToken, r.orderToken));
    await expect(completeTicketOrder(db, o.providerRef!, { amountOre: 1 })).rejects.toThrow(/beløb/);
    expect((await getTicketOrder(db, r.orderToken))!.status).toBe("pending");
    await pay(r.orderToken);
  });

  it("sælger aldrig flere end pladserne, og et udløbet hold frigiver pladserne", async () => {
    // 3 solgt af 5. To pladser tilbage.
    await expect(buy(eventId, 3, "k3@example.test")).rejects.toThrow(/kun 2 billetter/);
    const held = await buy(eventId, 2, "k4@example.test");
    await expect(buy(eventId, 1, "k5@example.test")).rejects.toThrow(/udsolgt/);
    expect((await getPublicTicketEvent(db, eventId))!.open).toBe(false);
    // Holdet udløber: pladserne kan købes af andre.
    const later = new Date(Date.now() + (HOLD_MINUTES + 1) * 60_000);
    const other = await buy(eventId, 2, "k5@example.test", later);
    await pay(other.orderToken, later);
    // Den første betaler for sent, og pladserne er væk.
    await expect(pay(held.orderToken, later)).rejects.toThrow(/givet videre/);
    expect((await getTicketOrder(db, held.orderToken))!.status).toBe("pending");
  });

  it("holder ikke pladser for samtidige køb: to sidste pladser kan ikke købes begge", async () => {
    const e = await createTicketEvent(db, await ctxOf("karen"), clubId, input({ name: "Sidste plads", capacity: 1 }));
    const results = await Promise.allSettled([buy(e.id, 1, "a1@example.test"), buy(e.id, 1, "a2@example.test"), buy(e.id, 1, "a3@example.test")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("begrænser bestillinger pr. IP og pr. e-mail", async () => {
    const e = await createTicketEvent(db, await ctxOf("karen"), clubId, input({ name: "Mange", capacity: null }));
    for (let i = 0; i < MAX_ORDERS_PER_IP_PER_HOUR; i++) await buy(e.id, 1, `ip${i}@example.test`, new Date(), "1.2.3.4");
    await expect(buy(e.id, 1, "ny@example.test", new Date(), "1.2.3.4")).rejects.toThrow(/mange bestillinger/);
    await buy(e.id, 1, "dobbelt@example.test");
    await buy(e.id, 1, "dobbelt@example.test");
    await buy(e.id, 1, "dobbelt@example.test");
    await expect(buy(e.id, 1, "dobbelt@example.test")).rejects.toThrow(/venter på betaling/);
  });

  it("gratis billetter udstedes med det samme og sender mail", async () => {
    const e = await createTicketEvent(db, await ctxOf("karen"), clubId, input({ name: "Gratis", priceOre: 0 }));
    const before = mails.length;
    const r = await buy(e.id, 2, "gratis@example.test");
    expect(r.redirectUrl).toContain("/billetter/ordre/");
    const order = (await getTicketOrder(db, r.orderToken))!;
    expect(order.status).toBe("paid");
    expect(order.tickets).toHaveLength(2);
    expect(mails.length).toBe(before + 1);
    expect(mails.at(-1)!.text).toContain(`/billetter/ordre/${r.orderToken}`);
  });

  it("lukker salget efter lukketidspunktet og for aflyste arrangementer", async () => {
    const karen = await ctxOf("karen");
    const closed = await createTicketEvent(db, karen, clubId, input({ name: "Lukket", saleClosesAt: new Date(Date.now() + 3_600_000) }));
    await expect(buy(closed.id, 1, "l1@example.test", new Date(Date.now() + 2 * 3_600_000))).rejects.toThrow(/lukket/);
    const e = await createTicketEvent(db, karen, clubId, input({ name: "Aflyses", capacity: 10 }));
    const pending = await buy(e.id, 1, "l2@example.test");
    const paid = await buy(e.id, 1, "l3@example.test");
    await pay(paid.orderToken);
    expect(await cancelTicketEvent(db, karen, e.id)).toEqual({ paidToRefund: 1 });
    await expect(buy(e.id, 1, "l4@example.test")).rejects.toThrow(/aflyst/);
    expect((await getTicketOrder(db, pending.orderToken))!.status).toBe("cancelled");
    expect((await getPublicTicketEvent(db, e.id))!.open).toBe(false);
    await expect(updateTicketEvent(db, karen, e.id, input())).rejects.toThrow(/aflyst/);
    const check = await checkTicket(db, karen, (await getTicketOrder(db, paid.orderToken))!.tickets[0].code);
    expect(check.found && check.status).toBe("cancelled");
  });

  it("afviser at sænke pladserne under det solgte", async () => {
    const karen = await ctxOf("karen");
    const e = await createTicketEvent(db, karen, clubId, input({ name: "Pladser", capacity: 10 }));
    await pay((await buy(e.id, 4, "p1@example.test")).orderToken);
    await expect(updateTicketEvent(db, karen, e.id, input({ name: "Pladser", capacity: 3 }))).rejects.toThrow(/solgt flere/);
    await updateTicketEvent(db, karen, e.id, input({ name: "Pladser", capacity: 4 }));
  });
});

describe("scanning", () => {
  let code: string;
  let eventId: string;
  beforeAll(async () => {
    eventId = (await createTicketEvent(db, await ctxOf("karen"), clubId, input({ name: "Scan", capacity: 20 }))).id;
    const r = await buy(eventId, 2, "scan@example.test");
    await pay(r.orderToken);
    code = (await getTicketOrder(db, r.orderToken))!.tickets[0].code;
  });

  it("lader kun admin, kasserer (Sofie) og trænere scanne, og afviser ugyldige koder", async () => {
    await expect(checkTicket(db, await ctxOf("ali"), code)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(admitTicket(db, await ctxOf("ali"), code)).rejects.toBeInstanceOf(ForbiddenError);
    for (const k of ["karen", "mette", "sofie"] as const) {
      const c = await checkTicket(db, await ctxOf(k), code);
      expect(c.found && c.status).toBe("valid");
    }
    expect(await checkTicket(db, await ctxOf("karen"), "findes-ikke-men-lang-nok-xxxxxxxx")).toEqual({ found: false });
    expect(await checkTicket(db, await ctxOf("karen"), "kort")).toEqual({ found: false });
  });

  it("slipper en billet ind én gang, også ved samtidige scanninger", async () => {
    const mette = await ctxOf("mette");
    const karen = await ctxOf("karen");
    const [a, b] = await Promise.all([admitTicket(db, mette, code), admitTicket(db, karen, code)]);
    const statuses = [a, b].map((r) => (r.found ? r.status : "?"));
    expect(statuses.filter((s) => s === "valid")).toHaveLength(1);
    expect(statuses.filter((s) => s === "used")).toHaveLength(1);
    const again = await checkTicket(db, karen, code);
    expect(again.found && again.status).toBe("used");
    const stats = (await listTicketEvents(db, karen, clubId)).find((e) => e.id === eventId)!;
    expect(stats.sold).toBe(2);
    expect(stats.used).toBe(1);
  });

  it("gør refunderede billetter ugyldige og frigiver pladserne", async () => {
    const karen = await ctxOf("karen");
    const r = await buy(eventId, 3, "refund@example.test");
    await pay(r.orderToken);
    const o = (await getTicketOrder(db, r.orderToken))!;
    await expect(refundTicketOrder(db, await ctxOf("mette"), (await listTicketOrders(db, karen, eventId))[0].id, mockProvider)).rejects.toBeInstanceOf(ForbiddenError);
    const orderId = (await listTicketOrders(db, karen, eventId)).find((x) => x.buyerEmail === "refund@example.test")!.id;
    await refundTicketOrder(db, karen, orderId, mockProvider);
    await expect(refundTicketOrder(db, karen, orderId, mockProvider)).rejects.toThrow(/betalte/);
    expect((await getTicketOrder(db, r.orderToken))!.status).toBe("refunded");
    const c = await checkTicket(db, karen, o.tickets[0].code);
    expect(c.found && c.status).toBe("void");
    const res = await admitTicket(db, karen, o.tickets[0].code);
    expect(res.found && res.status).toBe("void");
    expect((await listTicketEvents(db, karen, clubId)).find((e) => e.id === eventId)!.sold).toBe(2);
  });
});

describe("hjemmesiden og isolation", () => {
  it("viser arrangementer med åbent salg på hjemmesiden uden persondata", async () => {
    const karen = await ctxOf("karen");
    await saveSiteSettings(db, karen, clubId, { enabled: true, intro: null, contact: null, showTeams: true, showCalendar: true });
    const site = (await getPublicSite(db, "skovby-if"))!;
    expect(site.tickets.some((t) => t.name === "Fest")).toBe(true);
    expect(site.tickets.find((t) => t.name === "Fest")!.soldOut).toBe(true);
    expect(site.tickets.some((t) => t.name === "Aflyses")).toBe(false);
    const json = JSON.stringify(site);
    expect(json).not.toContain("example.test");
    expect(json).not.toContain("Gæst");
    expect((await listOpenTicketEvents(db, clubId)).length).toBeGreaterThan(0);
  });

  it("viser aldrig en anden forenings bestillinger (row-level security)", async () => {
    await withUserScope(db, demo.users.sofie.user.id, async (tx) => {
      const rows = await tx.select().from(ticketOrders);
      expect(rows.every((r) => r.clubId === clubId)).toBe(true);
    });
  });

  it("finder ikke ordrer med et gættet link", async () => {
    expect(await getTicketOrder(db, "x".repeat(32))).toBeNull();
    expect(await getTicketOrder(db, "../etc/passwd")).toBeNull();
  });
});
