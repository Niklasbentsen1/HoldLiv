// Holdkassen mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo, seedTeamFundDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { addClubMember, addFundEntry, addTeamMember, cancelFundEntry, createChildProfile, deleteChildProfile, getTeamFund, setTeamModule } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
let u9: string;
let u11: string;

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
  u9 = demo.teams.u9.id;
  u11 = demo.teams.u11.id;
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const kid = (k: keyof typeof demo.kids) => demo.kids[k].id;

describe("holdkasse", () => {
  it("kræver at modulet er slået til", async () => {
    await expect(getTeamFund(db, await ctxOf("mette"), u9)).rejects.toThrow(/ikke slået til/);
    await seedTeamFundDemo(db, demo);
  });

  it("viser saldo til hele holdet, men navne kun til trænerne", async () => {
    const coach = await getTeamFund(db, await ctxOf("mette"), u9);
    expect(coach.balanceOre).toBe(3 * 5000 - 4200);
    expect(coach.depositedOre).toBe(15000);
    expect(coach.spentOre).toBe(4200);
    expect(coach.entries.some((e) => e.payerName)).toBe(true);
    // Niklas er forælder til Emma på U9: ser saldo og poster, ikke navne.
    const parent = await getTeamFund(db, await ctxOf("ali"), u9);
    expect(parent.balanceOre).toBe(coach.balanceOre);
    expect(parent.canManage).toBe(false);
    expect(parent.entries.every((e) => e.payerName === null)).toBe(true);
    expect(parent.players).toEqual([]);
  });

  it("lader kun trænere og admin bogføre, og ikke fremmede at se", async () => {
    await expect(addFundEntry(db, await ctxOf("ali"), u9, { kind: "deposit", amountOre: 100, description: "x" })).rejects.toThrow(/Kun trænere/);
    await expect(getTeamFund(db, await ctxOf("peter"), u9)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addFundEntry(db, await ctxOf("jonas"), u9, { kind: "deposit", amountOre: 100, description: "x" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("afviser ugyldige beløb, tekst, datoer og personer uden for holdet", async () => {
    const mette = await ctxOf("mette");
    for (const bad of [0, -1, 1.5, 10_000_001]) {
      await expect(addFundEntry(db, mette, u9, { kind: "deposit", amountOre: bad, description: "x" })).rejects.toThrow(/Beløbet/);
    }
    await expect(addFundEntry(db, mette, u9, { kind: "deposit", amountOre: 100, description: "  " })).rejects.toThrow(/Skriv/);
    await expect(addFundEntry(db, mette, u9, { kind: "deposit", amountOre: 100, description: "x", entryDate: "2999-01-01" })).rejects.toThrow(/fremtiden/);
    await expect(addFundEntry(db, mette, u9, { kind: "deposit", amountOre: 100, description: "x", entryDate: "2001-01-01" })).rejects.toThrow(/for langt/);
    await expect(addFundEntry(db, mette, u9, { kind: "deposit", amountOre: 100, description: "x", entryDate: "ikke en dato" })).rejects.toThrow(/gyldig dato/);
    await expect(addFundEntry(db, mette, u9, { kind: "deposit", amountOre: 100, description: "x", profileId: kid("william") })).rejects.toThrow(/ikke på holdet/);
    await expect(addFundEntry(db, mette, u9, { kind: "withdrawal", amountOre: 100, description: "x", profileId: kid("emma") })).rejects.toThrow(/Kun en indbetaling/);
  });

  it("lader ikke kassen gå i minus", async () => {
    const mette = await ctxOf("mette");
    const { balanceOre } = await getTeamFund(db, mette, u9);
    await expect(addFundEntry(db, mette, u9, { kind: "withdrawal", amountOre: balanceOre + 1, description: "For meget" })).rejects.toThrow(/ikke penge nok/);
    await addFundEntry(db, mette, u9, { kind: "withdrawal", amountOre: balanceOre, description: "Tøm kassen" });
    expect((await getTeamFund(db, mette, u9)).balanceOre).toBe(0);
  });

  it("holder to samtidige udgifter fra at tømme den samme saldo", async () => {
    const mette = await ctxOf("mette");
    await addFundEntry(db, mette, u9, { kind: "deposit", amountOre: 10000, description: "Påfyldning" });
    const results = await Promise.allSettled([
      addFundEntry(db, mette, u9, { kind: "withdrawal", amountOre: 7000, description: "A" }),
      addFundEntry(db, mette, u9, { kind: "withdrawal", amountOre: 7000, description: "B" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getTeamFund(db, mette, u9)).balanceOre).toBe(3000);
  });

  it("annullerer poster uden at slette dem, og kun en gang", async () => {
    const mette = await ctxOf("mette");
    const before = await getTeamFund(db, mette, u9);
    const spend = before.entries.find((e) => e.description === "A" || e.description === "B")!;
    await cancelFundEntry(db, mette, spend.id);
    const after = await getTeamFund(db, mette, u9);
    expect(after.balanceOre).toBe(before.balanceOre + 7000);
    expect(after.entries.find((e) => e.id === spend.id)?.cancelled).toBe(true);
    await expect(cancelFundEntry(db, mette, spend.id)).rejects.toThrow(/allerede annulleret/);
    await expect(cancelFundEntry(db, await ctxOf("ali"), spend.id)).rejects.toThrow(/Kun trænere/);
  });

  it("kan ikke annullere en indbetaling, der allerede er brugt", async () => {
    const mette = await ctxOf("mette");
    const fund = await getTeamFund(db, mette, u9);
    const dep = fund.entries.find((e) => e.description === "Påfyldning")!;
    await addFundEntry(db, mette, u9, { kind: "withdrawal", amountOre: fund.balanceOre, description: "Brugt op" });
    await expect(cancelFundEntry(db, mette, dep.id)).rejects.toThrow(/allerede brugt/);
  });

  it("er adskilt pr. hold", async () => {
    await setTeamModule(db, await ctxOf("karen"), u11, "teamfund", true);
    const jonas = await ctxOf("jonas");
    expect((await getTeamFund(db, jonas, u11)).entries).toEqual([]);
    await addFundEntry(db, jonas, u11, { kind: "deposit", amountOre: 2500, description: "Første" });
    expect((await getTeamFund(db, jonas, u11)).balanceOre).toBe(2500);
    expect((await getTeamFund(db, await ctxOf("mette"), u9)).entries.some((e) => e.description === "Første")).toBe(false);
  });

  it("fjerner indbetalerens navn fra posten, når barnets profil slettes, men beholder beløbet", async () => {
    const niklas = await ctxOf("niklas");
    const child = await createChildProfile(db, niklas, { firstName: "Tobias", lastName: "Test", birthDate: "2017-03-03" });
    const mette = await ctxOf("mette");
    await addClubMember(db, await ctxOf("karen"), demo.club.id, child.id);
    await addTeamMember(db, mette, u9, child.id, "player");
    await addFundEntry(db, mette, u9, { kind: "deposit", amountOre: 1234, description: "Fra Tobias Test", profileId: child.id });
    const withName = await getTeamFund(db, mette, u9);
    expect(withName.entries.find((e) => e.description === "Fra Tobias Test")?.payerName).toBe("Tobias Test");
    expect(await deleteChildProfile(db, await ctxOf("niklas"), child.id)).toBe("deleted");
    const after = await getTeamFund(db, mette, u9);
    expect(after.entries.some((e) => e.description === "Fra Tobias Test")).toBe(false);
    const kept = after.entries.find((e) => e.description === "Indbetaling (slettet medlem)");
    expect(kept?.amountOre).toBe(1234);
    expect(kept?.payerName).toBeNull();
  });
});
