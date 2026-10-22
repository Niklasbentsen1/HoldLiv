// Camps: tilmelding for sig selv og børn, venteliste, søskenderabat, betaling via opkrævning og afmelding.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { loadAccessContext } from "../src/auth/context";
import {
  registerUser, createClub, createCamp, updateCamp, cancelCamp, signUpForCamp, cancelCampSignup, listCampsForMe, listClubCamps, listCampSignups,
  registerManualPayment, refundCharge,
} from "../src/services";
import { campSignups, charges, clubMemberships, guardianships, profiles } from "../src/db/schema";
import { mockProvider } from "../src/lib/payments";

const { db, sql, reset } = testDb();
const now = new Date("2026-06-01T12:00:00Z");
const sent: { to: string; subject: string }[] = [];
const deliver = { mail: async (to: string, subject: string) => void sent.push({ to, subject }), sms: null, baseUrl: "https://x.test" };
let clubId: string;
let admin: Awaited<ReturnType<typeof loadAccessContext>>;

const ctxOf = async (userId: string) => loadAccessContext(db, userId, now);
async function member(email: string, first: string, birth = "1985-01-01") {
  const u = await registerUser(db, email, { firstName: first, lastName: "Test", birthDate: birth });
  await db.insert(clubMemberships).values({ clubId, profileId: u.profile.id });
  return { ...u, ctx: await ctxOf(u.user.id) };
}
const camp = (over: Partial<Parameters<typeof createCamp>[3]> = {}) =>
  createCamp(db, admin, clubId, { name: "Sommercamp", startsOn: "2026-07-06", endsOn: "2026-07-10", priceOre: 100_000, siblingDiscountPercent: 20, capacity: 2, ...over });

beforeAll(async () => {
  await reset();
  const a = await registerUser(db, "admin@camp.test", { firstName: "Ad", lastName: "Min", birthDate: "1970-01-01" });
  clubId = (await createClub(db, await ctxOf(a.user.id), "Camp IF", "camp-if")).id;
  admin = await ctxOf(a.user.id);
});
afterAll(async () => {
  await sql.end();
});

describe("oprettelse", () => {
  it("kun admin/kasserer opretter, og værdierne tjekkes", async () => {
    const m = await member("m0@camp.test", "Mia");
    await expect(createCamp(db, m.ctx, clubId, { name: "X", startsOn: "2026-07-01", endsOn: "2026-07-02", priceOre: 1 })).rejects.toThrow();
    await expect(camp({ name: " " })).rejects.toThrow("navn");
    await expect(camp({ endsOn: "2026-07-01" })).rejects.toThrow("Slutdatoen");
    await expect(camp({ priceOre: -1 })).rejects.toThrow("Prisen");
    await expect(camp({ siblingDiscountPercent: 101 })).rejects.toThrow("0 til 100");
    await expect(camp({ signupDeadline: "2026-08-01" })).rejects.toThrow("fristen");
    await expect(camp({ capacity: -1 })).rejects.toThrow("pladser");
  });
});

describe("tilmelding, venteliste og betaling", () => {
  it("giver plads og opkrævning, derefter venteliste, og rykker op ved afmelding", async () => {
    const c = await camp();
    const a = await member("a@camp.test", "Anna");
    const b = await member("b@camp.test", "Bo");
    const d = await member("d@camp.test", "Dan");
    const ra = await signUpForCamp(db, a.ctx, c.id, a.profile.id);
    expect(ra).toMatchObject({ status: "confirmed", amountOre: 100_000 });
    const [ch] = await db.select().from(charges).where(eq(charges.profileId, a.profile.id));
    expect(ch).toMatchObject({ kind: "camp", status: "open", amountOre: 100_000, description: "Sommercamp", periodStart: "2026-07-06" });
    await expect(signUpForCamp(db, a.ctx, c.id, a.profile.id)).rejects.toThrow("tilmeldt");
    expect((await signUpForCamp(db, b.ctx, c.id, b.profile.id)).status).toBe("confirmed");
    expect((await signUpForCamp(db, d.ctx, c.id, d.profile.id)).status).toBe("waitlist");
    expect(await db.select().from(charges).where(eq(charges.profileId, d.profile.id))).toHaveLength(0);

    sent.length = 0;
    const [sa] = await db.select().from(campSignups).where(eq(campSignups.profileId, a.profile.id));
    await cancelCampSignup(db, a.ctx, sa.id, deliver);
    expect((await db.select().from(charges).where(eq(charges.profileId, a.profile.id)))[0].status).toBe("cancelled");
    const [sd] = await db.select().from(campSignups).where(eq(campSignups.profileId, d.profile.id));
    expect(sd.status).toBe("confirmed");
    expect(sent.map((m) => m.subject)).toEqual(["Der er plads på Sommercamp"]);
    expect(await db.select().from(charges).where(eq(charges.profileId, d.profile.id))).toHaveLength(1);
  });

  it("kun medlemmer tilmeldes, kun for sig selv eller egne børn, og ikke efter fristen eller til en aflyst camp", async () => {
    const c = await camp({ capacity: null, signupDeadline: "2026-06-30" });
    const outsider = await registerUser(db, "ude@camp.test", { firstName: "Ude", lastName: "Test", birthDate: "1990-01-01" });
    await expect(signUpForCamp(db, await ctxOf(outsider.user.id), c.id, outsider.profile.id)).rejects.toThrow("medlemmer");
    const m = await member("m1@camp.test", "Maja");
    const other = await member("m2@camp.test", "Ole");
    await expect(signUpForCamp(db, m.ctx, c.id, other.profile.id)).rejects.toThrow();
    const late = await loadAccessContext(db, m.user.id, new Date("2026-07-01T10:00:00Z"));
    await expect(signUpForCamp(db, late, c.id, m.profile.id)).rejects.toThrow("lukket");
    const dead = await camp({ capacity: null });
    await cancelCamp(db, admin, dead.id);
    await expect(signUpForCamp(db, m.ctx, dead.id, m.profile.id)).rejects.toThrow("aflyst");
  });

  it("samtidige tilmeldinger tager ikke flere pladser, end der er", async () => {
    const c = await camp({ capacity: 3 });
    const people = await Promise.all(Array.from({ length: 6 }, (_, i) => member(`race${i}@camp.test`, `Race${i}`)));
    const res = await Promise.allSettled(people.map((p) => signUpForCamp(db, p.ctx, c.id, p.profile.id)));
    expect(res.every((r) => r.status === "fulfilled")).toBe(true);
    const status = res.map((r) => (r as PromiseFulfilledResult<{ status: string }>).value.status);
    expect(status.filter((s) => s === "confirmed")).toHaveLength(3);
    expect(status.filter((s) => s === "waitlist")).toHaveLength(3);
  });
});

describe("søskenderabat", () => {
  it("første søskende betaler fuld pris, de næste får foreningens procent, og rabatten frosser", async () => {
    const c = await camp({ capacity: null });
    const parent = await member("far@camp.test", "Far");
    const kids = [];
    for (const [i, name] of ["Ida", "Jens", "Kim"].entries()) {
      const [k] = await db.insert(profiles).values({ firstName: name, lastName: "Test", birthDate: `201${2 + i}-03-01` }).returning();
      await db.insert(clubMemberships).values({ clubId, profileId: k.id });
      await db.insert(guardianships).values({ guardianProfileId: parent.profile.id, childProfileId: k.id });
      kids.push(k);
    }
    const ctx = await ctxOf(parent.user.id);
    const amounts = [];
    for (const k of kids) amounts.push((await signUpForCamp(db, ctx, c.id, k.id)).amountOre);
    expect(amounts).toEqual([100_000, 80_000, 80_000]);
    const [second] = await db.select().from(charges).where(eq(charges.profileId, kids[1].id));
    expect(second.description).toBe("Sommercamp (søskenderabat 20 %)");
    await updateCamp(db, admin, c.id, { name: "Sommercamp", startsOn: "2026-07-06", endsOn: "2026-07-10", priceOre: 200_000, siblingDiscountPercent: 50, capacity: null });
    expect((await db.select().from(charges).where(eq(charges.profileId, kids[1].id)))[0].amountOre).toBe(80_000);
    const mine = (await listCampsForMe(db, ctx)).find((x) => x.id === c.id)!;
    expect(mine.people.filter((p) => p.status === "confirmed")).toHaveLength(3);
    expect(mine.people.find((p) => p.firstName === "Jens")!.discountPercent).toBe(20);
  });
});

describe("betalt, refusion og aflysning", () => {
  it("en betalt plads kan først afmeldes efter refusion, og en 0-krone camp er betalt med det samme", async () => {
    const c = await camp({ capacity: 5 });
    const m = await member("pay@camp.test", "Pia");
    await signUpForCamp(db, m.ctx, c.id, m.profile.id);
    const [ch] = await db.select().from(charges).where(eq(charges.profileId, m.profile.id));
    await registerManualPayment(db, admin, ch.id, "kontant");
    const [s] = await db.select().from(campSignups).where(eq(campSignups.profileId, m.profile.id));
    await expect(cancelCampSignup(db, m.ctx, s.id)).rejects.toThrow("refundere");
    await refundCharge(db, admin, ch.id, mockProvider);
    await cancelCampSignup(db, m.ctx, s.id);
    const free = await camp({ name: "Gratis camp", priceOre: 0, capacity: null });
    expect(await signUpForCamp(db, m.ctx, free.id, m.profile.id)).toMatchObject({ status: "confirmed", amountOre: 0 });
    expect((await db.select().from(charges).where(eq(charges.description, "Gratis camp")))[0].status).toBe("paid");
  });

  it("aflysning annullerer åbne opkrævninger, giver besked og tæller betalte til refusion", async () => {
    const c = await camp({ name: "Vintercamp", capacity: null });
    const open = await member("o@camp.test", "Olga");
    const paid = await member("p@camp.test", "Per");
    await signUpForCamp(db, open.ctx, c.id, open.profile.id);
    await signUpForCamp(db, paid.ctx, c.id, paid.profile.id);
    const [pc] = await db.select().from(charges).where(eq(charges.profileId, paid.profile.id));
    await registerManualPayment(db, admin, pc.id, "kontant");
    sent.length = 0;
    expect(await cancelCamp(db, admin, c.id, deliver)).toEqual({ cancelledSignups: 2, paidToRefund: 1 });
    expect(sent.map((x) => x.subject)).toEqual(["Vintercamp er aflyst", "Vintercamp er aflyst"]);
    const cs = await db.select().from(charges).where(eq(charges.description, "Vintercamp"));
    expect(cs.map((x) => x.status).sort()).toEqual(["cancelled", "paid"]);
    await expect(cancelCamp(db, admin, c.id)).rejects.toThrow("allerede");
  });

  it("kassereren ser camps og deltagere, andre gør ikke", async () => {
    const m = await member("s@camp.test", "Sara");
    await expect(listClubCamps(db, m.ctx, clubId)).rejects.toThrow();
    const camps = await listClubCamps(db, admin, clubId);
    expect(camps.length).toBeGreaterThan(3);
    const withSignups = camps.find((c) => c.confirmed > 0)!;
    const list = await listCampSignups(db, admin, withSignups.id);
    expect(list[0]).toHaveProperty("chargeStatus");
    await expect(listCampSignups(db, m.ctx, withSignups.id)).rejects.toThrow();
  });
});
