// Kontingent udvidet: forholdsmæssig pris, rabatter, indmeldelsesgebyr, spærring ved restance og PDF-kvittering.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { loadAccessContext } from "../src/auth/context";
import {
  registerUser, createClub, createTeam, createFee, updateFee, updateMembership, previewChargeRun, runCharges, listMembers, listCharges,
  setArrearsBlock, joinTeamByInvite, registerManualPayment, getReceipt, createSingleCharge,
} from "../src/services";
import { charges, clubMemberships, guardianships, profiles, teamMembers, teams } from "../src/db/schema";
import { priceCharge } from "../src/lib/fees";
import { simplePdf } from "../src/lib/pdf";

const { db, sql, reset } = testDb();
const now = new Date("2026-11-02T12:00:00Z");
let clubId: string;
let admin: Awaited<ReturnType<typeof loadAccessContext>>;
let feeId: string;
let teamId: string;

async function child(first: string, year: number, parents: string[]) {
  const [c] = await db.insert(profiles).values({ firstName: first, lastName: "Familie", birthDate: `${year}-06-01` }).returning();
  await db.insert(clubMemberships).values({ clubId, profileId: c.id, feeId, joinedAt: new Date("2025-01-01T00:00:00Z") });
  for (const g of parents) await db.insert(guardianships).values({ guardianProfileId: g, childProfileId: c.id });
  return c.id;
}
async function parent(first: string) {
  const [p] = await db.insert(profiles).values({ firstName: first, lastName: "Forælder" }).returning();
  return p.id;
}

beforeAll(async () => {
  await reset();
  const u = await registerUser(db, "kasserer@kon.test", { firstName: "Ka", lastName: "Sserer", birthDate: "1970-01-01" });
  clubId = (await createClub(db, await loadAccessContext(db, u.user.id, now), "Kon IF", "kon-if")).id;
  admin = await loadAccessContext(db, u.user.id, now);
  teamId = (await createTeam(db, admin, clubId, "U9")).id;
});
afterAll(async () => {
  await sql.end();
});

describe("prisregler", () => {
  const period = { start: "2026-07-01", end: "2026-12-31" };
  const base = { amountOre: 100_000, period, joinedOn: "2026-01-01", prorate: false, siblingDiscountPercent: 0, siblingRank: 0, memberDiscountPercent: 0 };
  it("opkræver fuld pris uden regler", () => {
    expect(priceCharge(base)).toEqual({ amountOre: 100_000, notes: [] });
  });
  it("opkræver forholdsmæssigt for en indmeldelse midt i perioden og kun i den periode", () => {
    // 1. oktober til 31. december er 92 af 184 dage.
    expect(priceCharge({ ...base, prorate: true, joinedOn: "2026-10-01" })).toEqual({ amountOre: 50_000, notes: ["forholdsmæssigt: 92 af 184 dage"] });
    expect(priceCharge({ ...base, prorate: true, joinedOn: "2026-07-01" }).amountOre).toBe(100_000);
    expect(priceCharge({ ...base, prorate: true, joinedOn: "2026-03-01" }).amountOre).toBe(100_000);
    expect(priceCharge({ ...base, prorate: false, joinedOn: "2026-10-01" }).amountOre).toBe(100_000);
  });
  it("bruger den største af søskende- og medlemsrabat, og søskenderabat kun fra nummer to", () => {
    expect(priceCharge({ ...base, siblingDiscountPercent: 20, siblingRank: 0 }).amountOre).toBe(100_000);
    expect(priceCharge({ ...base, siblingDiscountPercent: 20, siblingRank: 1 })).toEqual({ amountOre: 80_000, notes: ["søskenderabat 20 %"] });
    expect(priceCharge({ ...base, siblingDiscountPercent: 20, siblingRank: 1, memberDiscountPercent: 50 })).toEqual({ amountOre: 50_000, notes: ["rabat 50 %"] });
    expect(priceCharge({ ...base, memberDiscountPercent: 100 }).amountOre).toBe(0);
  });
});

describe("opkrævning med foreningens egne regler", () => {
  it("opretter kontingent med gebyr, forholdsmæssighed og søskenderabat og afviser ugyldige procenter", async () => {
    const fee = await createFee(db, admin, clubId, { name: "Børn", amountOre: 100_000, interval: "half_year", joinFeeOre: 15_000, prorate: true, siblingDiscountPercent: 25 });
    feeId = fee.id;
    expect(fee).toMatchObject({ joinFeeOre: 15_000, prorate: true, siblingDiscountPercent: 25 });
    await expect(createFee(db, admin, clubId, { name: "X", amountOre: 1, interval: "year", siblingDiscountPercent: 101 })).rejects.toThrow("0 til 100");
    await expect(updateFee(db, admin, feeId, { joinFeeOre: -1 })).rejects.toThrow("Indmeldelsesgebyret");
    await expect(updateMembership(db, admin, clubId, (await parent("X")), { discountPercent: 150 })).rejects.toThrow("0 til 100");
  });

  it("giver ældste fuld pris, yngste søskende rabat, og forhåndsvisningen viser det samme som opkrævningen", async () => {
    const mor = await parent("Mor");
    const old = await child("Ældst", 2014, [mor]);
    const mid = await child("Midt", 2016, [mor]);
    const young = await child("Yngst", 2018, [mor]);
    const single = await child("Alene", 2015, []);
    const preview = await previewChargeRun(db, admin, feeId, "2026-11-02");
    const by = (id: string) => preview.members.find((m) => m.profileId === id)!;
    expect(by(old).amountOre).toBe(100_000);
    expect(by(mid)).toMatchObject({ amountOre: 75_000, notes: ["søskenderabat 25 %"] });
    expect(by(young).amountOre).toBe(75_000);
    expect(by(single).amountOre).toBe(100_000);
    expect(by(old).joinFeeOre).toBe(15_000);
    expect(preview.totalOre).toBe(100_000 * 2 + 75_000 * 2 + 15_000 * 4);

    const run = await runCharges(db, admin, feeId, "2026-11-02");
    expect(preview).toMatchObject({ joinFeeCount: 4, joinFeeTotalOre: 60_000, firstRun: true });
    expect(run).toMatchObject({ created: 4, joinFees: 4, totalOre: preview.totalOre });
    const rows = await db.select().from(charges).where(eq(charges.profileId, young));
    expect(rows.map((r) => [r.kind, r.amountOre]).sort()).toEqual([["fee", 75_000], ["join_fee", 15_000]]);
    expect(rows.find((r) => r.kind === "fee")!.description).toContain("søskenderabat 25 %");
    // Kan køres igen uden dubletter, og indmeldelsesgebyret kommer kun én gang.
    expect(await runCharges(db, admin, feeId, "2026-11-02")).toMatchObject({ created: 0 });
    const next = await runCharges(db, admin, feeId, "2027-02-01");
    expect(next).toMatchObject({ created: 4, joinFees: 0 });
  });

  it("giver ikke indmeldelsesgebyr til et medlem, der allerede har betalt kontingent", async () => {
    const fee = await createFee(db, admin, clubId, { name: "Gamle", amountOre: 50_000, interval: "half_year" });
    const [m] = await db.insert(profiles).values({ firstName: "Gammel", lastName: "Medlem", birthDate: "1980-01-01" }).returning();
    await db.insert(clubMemberships).values({ clubId, profileId: m.id, feeId: fee.id, joinedAt: new Date("2019-03-01T00:00:00Z") });
    expect(await runCharges(db, admin, fee.id, "2026-07-02")).toMatchObject({ created: 1, joinFees: 0 });
    // Foreningen indfører først et gebyr nu: det gamle medlem skal stadig ikke have det, men et nyt skal.
    await updateFee(db, admin, fee.id, { joinFeeOre: 20_000 });
    const [nyt] = await db.insert(profiles).values({ firstName: "Ny", lastName: "Medlem", birthDate: "1981-01-01" }).returning();
    await db.insert(clubMemberships).values({ clubId, profileId: nyt.id, feeId: fee.id, joinedAt: new Date("2026-12-01T00:00:00Z") });
    const preview = await previewChargeRun(db, admin, fee.id, "2027-01-02");
    expect(preview.members.find((x) => x.profileId === m.id)!.joinFeeOre).toBe(0);
    expect(preview.members.find((x) => x.profileId === nyt.id)!.joinFeeOre).toBe(20_000);
    await db.delete(clubMemberships).where(eq(clubMemberships.profileId, nyt.id));
    await db.update(clubMemberships).set({ feeId: null }).where(eq(clubMemberships.profileId, m.id));
  });

  it("kan opkræve kontingent uden indmeldelsesgebyr, og gebyret kommer så aldrig bagefter", async () => {
    const fee = await createFee(db, admin, clubId, { name: "Import", amountOre: 30_000, interval: "year", joinFeeOre: 10_000 });
    const [m] = await db.insert(profiles).values({ firstName: "Importeret", lastName: "Medlem", birthDate: "1975-01-01" }).returning();
    await db.insert(clubMemberships).values({ clubId, profileId: m.id, feeId: fee.id, joinedAt: new Date("2020-01-01T00:00:00Z") });
    expect((await previewChargeRun(db, admin, fee.id, "2027-03-01")).joinFeeCount).toBe(1);
    expect(await runCharges(db, admin, fee.id, "2027-03-01", undefined, { includeJoinFee: false })).toMatchObject({ created: 1, joinFees: 0 });
    expect((await previewChargeRun(db, admin, fee.id, "2028-03-01")).joinFeeCount).toBe(0);
    await db.update(clubMemberships).set({ feeId: null }).where(eq(clubMemberships.profileId, m.id));
  });

  it("opkræver forholdsmæssigt for et nyt medlem og håndterer rabat på 100 % som betalt", async () => {
    const fresh = await child("Ny", 2017, []);
    await db.update(clubMemberships).set({ joinedAt: new Date("2027-10-01T10:00:00Z") }).where(eq(clubMemberships.profileId, fresh));
    const pre = await previewChargeRun(db, admin, feeId, "2027-11-15");
    expect(pre.members.find((m) => m.profileId === fresh)).toMatchObject({ amountOre: 50_000 });
    const frivillig = await child("Frivillig", 2013, []);
    await updateMembership(db, admin, clubId, frivillig, { discountPercent: 100 });
    await runCharges(db, admin, feeId, "2027-11-15");
    const fees = (await db.select().from(charges).where(eq(charges.profileId, frivillig))).filter((r) => r.kind === "fee");
    expect(fees.length).toBeGreaterThan(0);
    expect(fees.every((r) => r.amountOre === 0 && r.status === "paid")).toBe(true);
    expect((await listMembers(db, admin, clubId, { filter: "all" })).find((m) => m.profileId === frivillig)!.discountPercent).toBe(100);
  });
});

describe("spærring ved restance", () => {
  it("spærrer først efter foreningens egen grænse og kun ved forfaldne, ubetalte opkrævninger", async () => {
    const mor = await parent("Spær");
    const kid = await child("Sat", 2016, [mor]);
    const user = await registerUser(db, "forælder@kon.test", { firstName: "Fo", lastName: "Rælder", birthDate: "1985-01-01" });
    await db.insert(guardianships).values({ guardianProfileId: user.profile.id, childProfileId: kid });
    await db.insert(clubMemberships).values({ clubId, profileId: user.profile.id }).onConflictDoNothing();
    const [t] = await db.select().from(teams).where(eq(teams.id, teamId));
    const ctx = await loadAccessContext(db, user.user.id, now);
    await createSingleCharge(db, admin, clubId, kid, { description: "Stævne", amountOre: 20_000, dueDate: "2026-10-01" });
    // Ingen grænse: ingen spærring.
    expect((await joinTeamByInvite(db, ctx, t.inviteCode!, kid)).waitlisted).toBe(false);
    await db.delete(teamMembers).where(eq(teamMembers.profileId, kid));
    await setArrearsBlock(db, admin, clubId, 30);
    // Forfalden for 32 dage siden: spærret.
    await expect(joinTeamByInvite(db, ctx, t.inviteCode!, kid)).rejects.toThrow("forfalden betaling");
    expect((await listMembers(db, admin, clubId, { filter: "all" })).find((m) => m.profileId === kid)!.blocked).toBe(true);
    await setArrearsBlock(db, admin, clubId, 60);
    expect((await joinTeamByInvite(db, ctx, t.inviteCode!, kid)).waitlisted).toBe(false);
    await db.delete(teamMembers).where(eq(teamMembers.profileId, kid));
    // Betales den, er spærringen væk.
    await setArrearsBlock(db, admin, clubId, 0);
    const [open] = (await listCharges(db, admin, clubId, "open")).filter((c) => c.profileId === kid);
    await expect(joinTeamByInvite(db, ctx, t.inviteCode!, kid)).rejects.toThrow("forfalden");
    await registerManualPayment(db, admin, open.id, "kontant");
    expect((await joinTeamByInvite(db, ctx, t.inviteCode!, kid)).waitlisted).toBe(false);
    await expect(setArrearsBlock(db, ctx, clubId, 10)).rejects.toThrow();
    await expect(setArrearsBlock(db, admin, clubId, -1)).rejects.toThrow("0 til 365");
    await setArrearsBlock(db, admin, clubId, null);
  });
});

describe("kvittering", () => {
  it("giver en PDF til betaleren og kassereren, men ikke for ubetalte eller fremmede", async () => {
    const mor = await parent("Kvit");
    const kid = await child("Betalt", 2016, [mor]);
    const user = await registerUser(db, "betaler@kon.test", { firstName: "Be", lastName: "Taler", birthDate: "1985-01-01" });
    await db.insert(guardianships).values({ guardianProfileId: user.profile.id, childProfileId: kid });
    const c = await createSingleCharge(db, admin, clubId, kid, { description: "Træningstrøje", amountOre: 25_000, dueDate: "2026-12-01" });
    const ctx = await loadAccessContext(db, user.user.id, now);
    await expect(getReceipt(db, ctx, c.id)).rejects.toThrow("ikke betalt");
    await registerManualPayment(db, admin, c.id, "bank");
    const r = await getReceipt(db, ctx, c.id);
    expect(r).toMatchObject({ clubName: "Kon IF", payerName: "Betalt Familie", description: "Træningstrøje", amountOre: 25_000 });
    expect(r.method).toContain("bank");
    const other = await registerUser(db, "fremmed@kon.test", { firstName: "Fre", lastName: "Mmed" });
    await expect(getReceipt(db, await loadAccessContext(db, other.user.id, now), c.id)).rejects.toThrow();
    expect((await getReceipt(db, admin, c.id)).number).toBe(c.id.slice(0, 8).toUpperCase());
  });
  it("laver en gyldig PDF med æøå", () => {
    const pdf = simplePdf([{ text: "Kvittering – Søren Ærø (Ødegård)", size: 14 }, { text: "650,00 kr." }]);
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf.includes(Buffer.from("Kvittering \u2013 S", "latin1"))).toBe(false);
    expect(pdf.includes(Buffer.from("Kvittering \x96 S\u00f8ren", "latin1"))).toBe(true);
    expect(simplePdf([{ text: "10 \u20ac \u201cX\u201d" }]).includes(Buffer.from([0x31, 0x30, 0x20, 0x80, 0x20, 0x93, 0x58, 0x94]))).toBe(true);
    expect(pdf.includes(Buffer.from("S\u00f8ren \u00c6r\u00f8 \\(\u00d8deg\u00e5rd\\)", "latin1"))).toBe(true);
    const xrefPos = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xrefPos, xrefPos + 4)).toBe("xref");
  });
});
