// Udlæg og kørsel: indsendelse med kvittering, kilometersats fra foreningen, godkendelse, betaling og adgang til bilag.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { loadAccessContext } from "../src/auth/context";
import {
  registerUser, createClub, createTeam, grantTreasurerByEmail, setMileageRate, submitExpense, listMyExpenses, listExpenses, cancelExpense, decideExpense,
  markExpensePaid, getExpenseReceipt, expensesCsv, deleteMyAccount, sniffReceipt,
} from "../src/services";
import { clubMemberships, expenseClaims, expenseReceipts } from "../src/db/schema";

const { db, sql, reset } = testDb();
const now = new Date("2026-11-02T12:00:00Z");
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const sent: { to: string; subject: string }[] = [];
const deliver = { mail: async (to: string, subject: string) => void sent.push({ to, subject }), sms: null, baseUrl: "https://x.test" };
let clubId: string;
let teamId: string;
let admin: Awaited<ReturnType<typeof loadAccessContext>>;
let coach: Awaited<ReturnType<typeof loadAccessContext>>;
let outsider: Awaited<ReturnType<typeof loadAccessContext>>;
let treasurer: Awaited<ReturnType<typeof loadAccessContext>>;

const ctxOf = async (userId: string) => loadAccessContext(db, userId, now);

beforeAll(async () => {
  await reset();
  const a = await registerUser(db, "admin@udl.test", { firstName: "Ad", lastName: "Min", birthDate: "1970-01-01" });
  clubId = (await createClub(db, await ctxOf(a.user.id), "Udlæg IF", "udlaeg-if")).id;
  admin = await ctxOf(a.user.id);
  teamId = (await createTeam(db, admin, clubId, "U15")).id;
  const c = await registerUser(db, "traener@udl.test", { firstName: "Tina", lastName: "Træner", birthDate: "1985-01-01" });
  await db.insert(clubMemberships).values({ clubId, profileId: c.profile.id });
  coach = await ctxOf(c.user.id);
  const o = await registerUser(db, "fremmed@udl.test", { firstName: "Fre", lastName: "Mmed", birthDate: "1990-01-01" });
  outsider = await ctxOf(o.user.id);
  const t = await registerUser(db, "kasserer@udl.test", { firstName: "Ka", lastName: "Sserer", birthDate: "1975-01-01" });
  await db.insert(clubMemberships).values({ clubId, profileId: t.profile.id });
  await grantTreasurerByEmail(db, admin, clubId, "kasserer@udl.test");
  treasurer = await ctxOf(t.user.id);
});
afterAll(async () => {
  await sql.end();
});

const base = { kind: "expense" as const, description: "Bolde og veste", spentOn: "2026-10-30", amountOre: 45_000 };

describe("indsendelse", () => {
  it("genkender filtyper på indholdet", () => {
    expect(sniffReceipt(JPEG)).toBe("image/jpeg");
    expect(sniffReceipt(PDF)).toBe("application/pdf");
    expect(sniffReceipt(new Uint8Array([0x4d, 0x5a, 0x90, 0]))).toBeNull();
  });

  it("kræver medlemskab, kvittering, gyldig fil, dato og beløb", async () => {
    await expect(submitExpense(db, outsider, clubId, { ...base, receipt: { bytes: JPEG } })).rejects.toThrow();
    await expect(submitExpense(db, coach, clubId, base)).rejects.toThrow("kvitteringen");
    await expect(submitExpense(db, coach, clubId, { ...base, receipt: { bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0]) } })).rejects.toThrow("foto");
    await expect(submitExpense(db, coach, clubId, { ...base, receipt: { bytes: new Uint8Array(6 * 1024 * 1024 + 1).fill(0xff) } })).rejects.toThrow("6 MB");
    await expect(submitExpense(db, coach, clubId, { ...base, amountOre: 0, receipt: { bytes: JPEG } })).rejects.toThrow("Beløbet");
    await expect(submitExpense(db, coach, clubId, { ...base, amountOre: 5_000_001, receipt: { bytes: JPEG } })).rejects.toThrow("Beløbet");
    await expect(submitExpense(db, coach, clubId, { ...base, spentOn: "2026-12-01", receipt: { bytes: JPEG } })).rejects.toThrow("fremtiden");
    await expect(submitExpense(db, coach, clubId, { ...base, spentOn: "2025-01-01", receipt: { bytes: JPEG } })).rejects.toThrow("et år");
    await expect(submitExpense(db, coach, clubId, { ...base, description: "  ", receipt: { bytes: JPEG } })).rejects.toThrow("hvad");
    await expect(submitExpense(db, coach, clubId, { ...base, teamId: "00000000-0000-0000-0000-000000000000", receipt: { bytes: JPEG } })).rejects.toThrow();
  });

  it("kørsel kræver en sats fra foreningen og kopierer den til kravet", async () => {
    const km = { kind: "mileage" as const, description: "Udekamp i Odense", spentOn: "2026-10-31", km: 123.4 };
    await expect(submitExpense(db, coach, clubId, km)).rejects.toThrow("kilometersats");
    await expect(setMileageRate(db, coach, clubId, 380)).rejects.toThrow();
    await expect(setMileageRate(db, admin, clubId, 0)).rejects.toThrow("Satsen");
    await setMileageRate(db, treasurer, clubId, 380);
    const c = await submitExpense(db, coach, clubId, { ...km, teamId });
    expect(c).toMatchObject({ kmTenths: 1234, rateOrePerKm: 380, amountOre: 46_892, status: "submitted" });
    await setMileageRate(db, admin, clubId, 400);
    expect((await listMyExpenses(db, coach)).find((x) => x.id === c.id)!.amountOre).toBe(46_892);
    await expect(submitExpense(db, coach, clubId, { ...km, km: 0 })).rejects.toThrow("kilometer");
    await cancelExpense(db, coach, c.id);
  });
});

describe("behandling", () => {
  let claimId: string;
  it("indsender med kvittering og giver admin og kasserer besked", async () => {
    sent.length = 0;
    const c = await submitExpense(db, coach, clubId, { ...base, teamId, receipt: { bytes: JPEG } }, deliver);
    claimId = c.id;
    expect(sent.map((m) => m.to).sort()).toEqual(["admin@udl.test", "kasserer@udl.test"]);
    expect((await listMyExpenses(db, coach))[0]).toMatchObject({ id: claimId, hasReceipt: true, clubName: "Udlæg IF" });
  });

  it("kun admin/kasserer ser kravene og kvitteringen, og ejeren ser sin egen", async () => {
    await expect(listExpenses(db, coach, clubId)).rejects.toThrow();
    await expect(listExpenses(db, outsider, clubId)).rejects.toThrow();
    expect((await listExpenses(db, admin, clubId, "open")).map((x) => x.id)).toEqual([claimId]);
    expect((await getExpenseReceipt(db, coach, claimId)).contentType).toBe("image/jpeg");
    expect((await getExpenseReceipt(db, treasurer, claimId)).data.length).toBe(JPEG.length);
    await expect(getExpenseReceipt(db, outsider, claimId)).rejects.toThrow();
  });

  it("afvisning kræver begrundelse, godkendelse giver besked, og kun godkendte kan betales", async () => {
    await expect(markExpensePaid(db, admin, claimId, null)).rejects.toThrow("godkendte");
    await expect(decideExpense(db, coach, claimId, "approve", null)).rejects.toThrow();
    await expect(decideExpense(db, admin, claimId, "reject", " ")).rejects.toThrow("begrundelse");
    sent.length = 0;
    await decideExpense(db, admin, claimId, "approve", null, deliver);
    expect(sent.map((m) => m.subject)).toEqual(["Dit udlæg på 450 kr. er godkendt"]);
    await expect(decideExpense(db, admin, claimId, "approve", null)).rejects.toThrow("allerede");
    await expect(cancelExpense(db, coach, claimId)).rejects.toThrow("allerede");
    const csv = await expensesCsv(db, admin, clubId);
    expect(csv).toContain("Tina Træner;Bolde og veste;Udlæg;2026-10-30;450,00;");
    sent.length = 0;
    await markExpensePaid(db, treasurer, claimId, "Overført 3/11", deliver);
    expect(sent.map((m) => m.subject)).toEqual(["Dit udlæg på 450 kr. er betalt"]);
    expect((await listMyExpenses(db, coach))[0]).toMatchObject({ status: "paid", payNote: "Overført 3/11" });
    expect((await expensesCsv(db, admin, clubId)).trim().split("\r\n")).toHaveLength(1);
  });

  it("afviste krav viser begrundelsen, og man kan ikke godkende sit eget, når andre kan", async () => {
    const c = await submitExpense(db, coach, clubId, { ...base, description: "=HYPERLINK(1)", receipt: { bytes: PDF } });
    await decideExpense(db, admin, c.id, "reject", "Bilaget er ulæseligt");
    expect((await listMyExpenses(db, coach)).find((x) => x.id === c.id)).toMatchObject({ status: "rejected", rejectReason: "Bilaget er ulæseligt" });
    const own = await submitExpense(db, treasurer, clubId, { ...base, receipt: { bytes: JPEG } });
    await expect(decideExpense(db, treasurer, own.id, "approve", null)).rejects.toThrow("dit eget");
    await decideExpense(db, admin, own.id, "approve", null);
    expect((await expensesCsv(db, admin, clubId))).toContain("Ka Sserer");
  });

  it("regnearket neutraliserer formler", async () => {
    const c = await submitExpense(db, coach, clubId, { ...base, description: "=HYPERLINK(1)", receipt: { bytes: PDF } });
    await decideExpense(db, admin, c.id, "approve", null);
    expect(await expensesCsv(db, admin, clubId)).toContain("'=HYPERLINK(1)");
  });

  it("den eneste admin kan godkende sit eget krav", async () => {
    await reset();
    const a = await registerUser(db, "alene@udl.test", { firstName: "Al", lastName: "Ene", birthDate: "1970-01-01" });
    const club = (await createClub(db, await ctxOf(a.user.id), "Solo IF", "solo-if")).id;
    const ctx = await ctxOf(a.user.id);
    const c = await submitExpense(db, ctx, club, { ...base, receipt: { bytes: JPEG } });
    await decideExpense(db, ctx, c.id, "approve", null);
    expect((await listExpenses(db, ctx, club, "unpaid"))).toHaveLength(1);
  });
});

describe("tilbagetrækning og sletning", () => {
  it("et tilbagetrukket krav mister kvitteringen; sletning af konto beholder kun godkendte krav", async () => {
    await reset();
    const a = await registerUser(db, "a2@udl.test", { firstName: "Ad", lastName: "Min", birthDate: "1970-01-01" });
    const club = (await createClub(db, await ctxOf(a.user.id), "Slet IF", "slet-if")).id;
    const adm = await ctxOf(a.user.id);
    const u = await registerUser(db, "s@udl.test", { firstName: "Slet", lastName: "Mig", birthDate: "1980-01-01" });
    await db.insert(clubMemberships).values({ clubId: club, profileId: u.profile.id });
    const me = await ctxOf(u.user.id);
    const c1 = await submitExpense(db, me, club, { ...base, receipt: { bytes: JPEG } });
    await cancelExpense(db, me, c1.id);
    expect(await db.select().from(expenseReceipts).where(eq(expenseReceipts.claimId, c1.id))).toHaveLength(0);
    await expect(cancelExpense(db, adm, c1.id)).rejects.toThrow();
    const keep = await submitExpense(db, me, club, { ...base, receipt: { bytes: JPEG } });
    await decideExpense(db, adm, keep.id, "approve", null);
    await submitExpense(db, me, club, { ...base, description: "Afventer", receipt: { bytes: PDF } });
    await deleteMyAccount(db, me, "s@udl.test");
    const left = await db.select().from(expenseClaims);
    expect(left.map((x) => x.status)).toEqual(["approved"]);
  });
});
