// Booking af baner, haller og udstyr: oprettelse, dobbeltbooking, antal enheder, godkendelse, leje og afbooking.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { loadAccessContext } from "../src/auth/context";
import {
  registerUser, createClub, createTeam, addTeamMember, createResource, updateResource, archiveResource, createBooking, approveBooking, rejectBooking, cancelBooking,
  listBookableResources, listClubBookings, listMyBookings, listClubResources, bookingPrice, registerManualPayment, refundCharge,
} from "../src/services";
import { bookings, charges, clubMemberships, guardianships, profiles } from "../src/db/schema";
import { mockProvider } from "../src/lib/payments";
import { parseLocalDateTime } from "../src/lib/time";

const { db, sql, reset } = testDb();
const now = new Date("2026-06-01T10:00:00Z");
const sent: { to: string; subject: string }[] = [];
const deliver = { mail: async (to: string, subject: string) => void sent.push({ to, subject }), sms: null, baseUrl: "https://x.test" };
let clubId: string;
let teamId: string;
let admin: Awaited<ReturnType<typeof loadAccessContext>>;
let coach: Awaited<ReturnType<typeof loadAccessContext>>;

const ctxOf = async (userId: string) => loadAccessContext(db, userId, now);
async function member(email: string, first: string, birth = "1985-01-01") {
  const u = await registerUser(db, email, { firstName: first, lastName: "Test", birthDate: birth });
  await db.insert(clubMemberships).values({ clubId, profileId: u.profile.id });
  return { ...u, ctx: await ctxOf(u.user.id) };
}
const at = (d: string, h: number, m = 0) => parseLocalDateTime(`2026-06-${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
const res = (over: Partial<Parameters<typeof createResource>[3]> = {}) => createResource(db, admin, clubId, { name: "Bane 1", kind: "court", ...over });

beforeAll(async () => {
  await reset();
  const a = await registerUser(db, "admin@book.test", { firstName: "Ad", lastName: "Min", birthDate: "1970-01-01" });
  clubId = (await createClub(db, await ctxOf(a.user.id), "Book IF", "book-if")).id;
  admin = await ctxOf(a.user.id);
  teamId = (await createTeam(db, admin, clubId, "U9", "2026")).id;
  const c = await member("coach@book.test", "Carla");
  await addTeamMember(db, admin, teamId, c.profile.id, "coach");
  coach = await ctxOf(c.user.id);
});
afterAll(async () => {
  await sql.end();
});

describe("ressourcer", () => {
  it("kun admin/kasserer opretter, og værdierne tjekkes", async () => {
    const m = await member("m0@book.test", "Mia");
    await expect(createResource(db, m.ctx, clubId, { name: "X", kind: "court" })).rejects.toThrow();
    await expect(res({ name: " " })).rejects.toThrow("navn");
    await expect(res({ quantity: 0 })).rejects.toThrow("Antal");
    await expect(res({ pricePerHourOre: -1 })).rejects.toThrow("Lejen");
    await expect(res({ pricePerHourOre: 2_000_000 })).rejects.toThrow("Lejen");
  });

  it("klubben kan selv ændre leje og antal, og arkiverede kan ikke bookes", async () => {
    const r = await res({ name: "Hal", kind: "hall", pricePerHourOre: 20_000 });
    await updateResource(db, admin, r.id, { name: "Hal", kind: "hall", pricePerHourOre: 35_000, quantity: 2 });
    const [row] = (await listClubResources(db, admin, clubId)).filter((x) => x.id === r.id);
    expect(row).toMatchObject({ pricePerHourOre: 35_000, quantity: 2 });
    await archiveResource(db, admin, r.id);
    const m = await member("m1@book.test", "Mie");
    await expect(createBooking(db, m.ctx, { resourceId: r.id, startsAt: at("10", 10), endsAt: at("10", 11) })).rejects.toThrow("arkiveret");
    expect((await listClubResources(db, admin, clubId)).some((x) => x.id === r.id)).toBe(false);
  });
});

describe("booking og dobbeltbooking", () => {
  it("afviser dobbeltbooking, men tillader tider, der støder op til hinanden", async () => {
    const r = await res({ name: "Bane A" });
    const a = await member("a@book.test", "Anna");
    const b = await member("b@book.test", "Bo");
    expect(await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("10", 10), endsAt: at("10", 11) })).toMatchObject({ status: "confirmed", amountOre: 0 });
    await expect(createBooking(db, b.ctx, { resourceId: r.id, startsAt: at("10", 10, 30), endsAt: at("10", 11, 30) })).rejects.toThrow("optaget");
    await expect(createBooking(db, b.ctx, { resourceId: r.id, startsAt: at("10", 9), endsAt: at("10", 10, 1) })).rejects.toThrow("optaget");
    await createBooking(db, b.ctx, { resourceId: r.id, startsAt: at("10", 11), endsAt: at("10", 12) });
    await createBooking(db, b.ctx, { resourceId: r.id, startsAt: at("10", 9), endsAt: at("10", 10) });
  });

  it("samtidige bookinger af den sidste ledige tid giver kun én", async () => {
    const r = await res({ name: "Bane B" });
    const people = await Promise.all([1, 2, 3, 4].map((i) => member(`race${i}@book.test`, `R${i}`)));
    const out = await Promise.allSettled(people.map((p) => createBooking(db, p.ctx, { resourceId: r.id, startsAt: at("11", 10), endsAt: at("11", 11) })));
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  });

  it("udstyr med flere enheder kan bookes, til de er brugt op", async () => {
    const r = await res({ name: "Bolde", kind: "equipment", quantity: 10 });
    const a = await member("e1@book.test", "Eva");
    await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("12", 10), endsAt: at("12", 11), quantity: 6 });
    await expect(createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("12", 10), endsAt: at("12", 11), quantity: 5 })).rejects.toThrow("Der er kun 4 ledige");
    await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("12", 10, 30), endsAt: at("12", 11), quantity: 4 });
    await expect(createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("12", 10), endsAt: at("12", 11), quantity: 11 })).rejects.toThrow("Der er kun 10");
  });

  it("tjekker tidsrummet", async () => {
    const r = await res({ name: "Bane C" });
    const a = await member("t@book.test", "Tim");
    await expect(createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("10", 11), endsAt: at("10", 10) })).rejects.toThrow("mindst 15");
    await expect(createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("10", 6), endsAt: at("10", 20) })).rejects.toThrow("højst vare 12");
    await expect(createBooking(db, a.ctx, { resourceId: r.id, startsAt: new Date("2026-05-31T10:00:00Z"), endsAt: new Date("2026-05-31T11:00:00Z") })).rejects.toThrow("fortiden");
    await expect(createBooking(db, a.ctx, { resourceId: r.id, startsAt: new Date("2028-01-01T10:00:00Z"), endsAt: new Date("2028-01-01T11:00:00Z") })).rejects.toThrow("et år");
  });

  it("kun medlemmer booker, og kun for sig selv eller egne børn", async () => {
    const r = await res({ name: "Bane D" });
    const outsider = await registerUser(db, "out@book.test", { firstName: "Ude", lastName: "Fra", birthDate: "1980-01-01" });
    const octx = await ctxOf(outsider.user.id);
    await expect(createBooking(db, octx, { resourceId: r.id, startsAt: at("13", 10), endsAt: at("13", 11) })).rejects.toThrow("aktive medlemmer");
    const a = await member("o1@book.test", "Ole");
    const b = await member("o2@book.test", "Ova");
    await expect(createBooking(db, a.ctx, { resourceId: r.id, profileId: b.profile.id, startsAt: at("13", 10), endsAt: at("13", 11) })).rejects.toThrow();
  });

  it("en forælder booker for sit barn", async () => {
    const r = await res({ name: "Bane E", pricePerHourOre: 10_000 });
    const parent = await member("par@book.test", "Per");
    const [child] = await db.insert(profiles).values({ firstName: "Lille", lastName: "Test", birthDate: "2016-01-01" }).returning();
    await db.insert(guardianships).values({ guardianProfileId: parent.profile.id, childProfileId: child.id });
    await db.insert(clubMemberships).values({ clubId, profileId: child.id });
    const pctx = await ctxOf(parent.user.id);
    const out = await createBooking(db, pctx, { resourceId: r.id, profileId: child.id, startsAt: at("14", 10), endsAt: at("14", 11) });
    expect(out.amountOre).toBe(10_000);
    expect((await listMyBookings(db, pctx)).map((x) => x.firstName)).toContain("Lille");
    const [ch] = await db.select().from(charges).where(eq(charges.profileId, child.id));
    expect(ch).toMatchObject({ kind: "booking", amountOre: 10_000, status: "open" });
  });
});

describe("leje", () => {
  it("regnes pr. time og enhed, og kan ændres uden at røre gamle opkrævninger", async () => {
    expect(bookingPrice(30_000, 1, at("10", 10), at("10", 11, 30))).toBe(45_000);
    expect(bookingPrice(1_000, 3, at("10", 10), at("10", 10, 20))).toBe(1_000);
    const r = await res({ name: "Bane F", pricePerHourOre: 20_000 });
    const a = await member("p1@book.test", "Pia");
    const first = await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("15", 10), endsAt: at("15", 11, 30) });
    expect(first.amountOre).toBe(30_000);
    await updateResource(db, admin, r.id, { name: "Bane F", kind: "court", pricePerHourOre: 40_000 });
    const second = await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("16", 10), endsAt: at("16", 11) });
    expect(second.amountOre).toBe(40_000);
    const rows = await db.select().from(charges).where(eq(charges.profileId, a.profile.id));
    expect(rows.map((c) => c.amountOre).sort()).toEqual([30_000, 40_000]);
  });

  it("hold-bookinger er uden leje, og kun trænere og admin booker for holdet", async () => {
    const r = await res({ name: "Bane G", pricePerHourOre: 50_000 });
    const out = await createBooking(db, coach, { resourceId: r.id, teamId, startsAt: at("17", 17), endsAt: at("17", 18) });
    expect(out).toMatchObject({ status: "confirmed", amountOre: 0 });
    const m = await member("pl@book.test", "Player");
    await expect(createBooking(db, m.ctx, { resourceId: r.id, teamId, startsAt: at("18", 17), endsAt: at("18", 18) })).rejects.toThrow();
    const [row] = await listMyBookings(db, coach);
    expect(row.teamName).toBe("U9");
  });

  it("afbooking annullerer den åbne opkrævning; en betalt kræver refundering", async () => {
    const r = await res({ name: "Bane H", pricePerHourOre: 20_000 });
    const a = await member("c1@book.test", "Cai");
    const b1 = await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("19", 10), endsAt: at("19", 11) });
    await cancelBooking(db, a.ctx, b1.id);
    const [c1] = await db.select().from(charges).where(eq(charges.id, (await db.select().from(bookings).where(eq(bookings.id, b1.id)))[0].chargeId!));
    expect(c1.status).toBe("cancelled");
    await expect(cancelBooking(db, a.ctx, b1.id)).rejects.toThrow("allerede");
    // Tiden er ledig igen.
    const b2 = await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("19", 10), endsAt: at("19", 11) });
    const chargeId = (await db.select().from(bookings).where(eq(bookings.id, b2.id)))[0].chargeId!;
    await registerManualPayment(db, admin, chargeId, "kontant");
    await expect(cancelBooking(db, a.ctx, b2.id)).rejects.toThrow("refundere");
    await refundCharge(db, admin, chargeId, mockProvider);
    await cancelBooking(db, a.ctx, b2.id);
  });

  it("andre end ejeren og foreningen kan ikke afbooke", async () => {
    const r = await res({ name: "Bane I" });
    const a = await member("x1@book.test", "Xia");
    const b = await member("x2@book.test", "Xan");
    const bk = await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("20", 10), endsAt: at("20", 11) });
    await expect(cancelBooking(db, b.ctx, bk.id)).rejects.toThrow();
    await cancelBooking(db, admin, bk.id);
  });
});

describe("godkendelse", () => {
  it("afventer, holder tiden, og opkrævningen kommer først ved godkendelse", async () => {
    const r = await res({ name: "Hal med godkendelse", kind: "hall", pricePerHourOre: 20_000, requiresApproval: true });
    const a = await member("g1@book.test", "Gry");
    const b = await member("g2@book.test", "Gus");
    const out = await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("22", 10), endsAt: at("22", 12) });
    expect(out).toMatchObject({ status: "pending", amountOre: 0 });
    await expect(createBooking(db, b.ctx, { resourceId: r.id, startsAt: at("22", 11), endsAt: at("22", 13) })).rejects.toThrow("optaget");
    expect(await db.select().from(charges).where(eq(charges.profileId, a.profile.id))).toHaveLength(0);
    expect((await listClubBookings(db, admin, clubId))[0]).toMatchObject({ status: "pending", firstName: "Gry" });
    await expect(approveBooking(db, a.ctx, out.id)).rejects.toThrow();
    sent.length = 0;
    await approveBooking(db, admin, out.id, deliver);
    const [ch] = await db.select().from(charges).where(eq(charges.profileId, a.profile.id));
    expect(ch).toMatchObject({ amountOre: 40_000, kind: "booking" });
    expect(sent.some((m) => m.subject.includes("bekræftet"))).toBe(true);
    await expect(approveBooking(db, admin, out.id)).rejects.toThrow("afventer ikke");
  });

  it("afvisning frigiver tiden, og admin booker uden godkendelse", async () => {
    const r = await res({ name: "Hal 2", kind: "hall", requiresApproval: true });
    const a = await member("h1@book.test", "Hus");
    const out = await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("23", 10), endsAt: at("23", 11) });
    await rejectBooking(db, admin, out.id, deliver);
    expect((await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("23", 10), endsAt: at("23", 11) })).status).toBe("pending");
    expect((await createBooking(db, admin, { resourceId: r.id, startsAt: at("24", 10), endsAt: at("24", 11) })).status).toBe("confirmed");
  });
});

describe("rettelser efter QA", () => {
  it("lejen låses ved booking: en prisændring, mens den afventer, ændrer ikke opkrævningen", async () => {
    const r = await res({ name: "Hal pris", kind: "hall", pricePerHourOre: 10_000, requiresApproval: true });
    const a = await member("q1@book.test", "Quinn");
    const out = await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("21", 10), endsAt: at("21", 11) });
    await updateResource(db, admin, r.id, { name: "Hal pris", kind: "hall", pricePerHourOre: 50_000, requiresApproval: true });
    await approveBooking(db, admin, out.id);
    const [ch] = await db.select().from(charges).where(eq(charges.profileId, a.profile.id));
    expect(ch.amountOre).toBe(10_000);
    expect(ch.description).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("ventelistede og inaktive medlemmer kan ikke booke", async () => {
    const r = await res({ name: "Bane status" });
    for (const status of ["waitlist", "inactive"] as const) {
      const m = await member(`${status}@book.test`, status);
      await db.update(clubMemberships).set({ status }).where(eq(clubMemberships.profileId, m.profile.id));
      await expect(createBooking(db, m.ctx, { resourceId: r.id, startsAt: at("09", 10), endsAt: at("09", 11) })).rejects.toThrow("aktive medlemmer");
      expect(await listBookableResources(db, m.ctx)).toEqual([]);
    }
  });

  it("antal kan ikke sættes under en kommende booking", async () => {
    const r = await res({ name: "Kegler", kind: "equipment", quantity: 10 });
    const a = await member("k1@book.test", "Kim");
    await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("08", 10), endsAt: at("08", 11), quantity: 6 });
    await expect(updateResource(db, admin, r.id, { name: "Kegler", kind: "equipment", quantity: 5 })).rejects.toThrow("mindst 6");
    await updateResource(db, admin, r.id, { name: "Kegler", kind: "equipment", quantity: 6 });
  });

  it("sletning af trænerens konto beholder holdets bookinger", async () => {
    const r = await res({ name: "Bane slet" });
    const c = await member("slet@book.test", "Slet");
    await addTeamMember(db, admin, teamId, c.profile.id, "coach");
    const cctx = await ctxOf(c.user.id);
    const team = await createBooking(db, cctx, { resourceId: r.id, teamId, startsAt: at("07", 10), endsAt: at("07", 11) });
    await createBooking(db, cctx, { resourceId: r.id, startsAt: at("07", 12), endsAt: at("07", 13) });
    const { deleteMyAccount } = await import("../src/services");
    await deleteMyAccount(db, cctx, "slet@book.test");
    const left = await db.select().from(bookings).where(eq(bookings.resourceId, r.id));
    expect(left.map((b) => b.id)).toEqual([team.id]);
  });
});

describe("oversigter", () => {
  it("viser kun hvem der har booket (fornavn eller hold), og kun i egne foreninger", async () => {
    const r = await res({ name: "Bane Z" });
    const a = await member("z1@book.test", "Zoe");
    await createBooking(db, a.ctx, { resourceId: r.id, startsAt: at("05", 10), endsAt: at("05", 11), note: "privat note" });
    const other = await registerUser(db, "z2@book.test", { firstName: "Fremmed", lastName: "X", birthDate: "1980-01-01" });
    expect(await listBookableResources(db, await ctxOf(other.user.id))).toEqual([]);
    const b = await member("z3@book.test", "Zed");
    const list = await listBookableResources(db, b.ctx);
    const row = list.find((x) => x.id === r.id)!;
    expect(row.busy).toEqual([expect.objectContaining({ who: "Zoe" })]);
    expect(JSON.stringify(row.busy)).not.toContain("privat");
    expect(row.people).toHaveLength(1);
    await expect(listClubBookings(db, b.ctx, clubId)).rejects.toThrow();
  });
});

describe("demoklubben", () => {
  it("seedBookingDemo giver ressourcer og bookinger", async () => {
    await reset();
    const { seedDemo, seedBookingDemo } = await import("../src/db/demo");
    const demo = await seedDemo(db);
    await seedBookingDemo(db, demo);
    const list = await listBookableResources(db, await loadAccessContext(db, demo.users.niklas.user.id));
    expect(list.map((r) => r.name).sort()).toEqual(["Bolde", "Kunststofbane", "Skovbyhallen"]);
    expect(list.find((r) => r.name === "Kunststofbane")!.busy).toHaveLength(2);
  });
});
