// Bødekassen mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { ageOn } from "../src/lib/age";
import {
  cancelFine,
  createFineType,
  getFineBox,
  giveFine,
  setFinePaid,
  setFineTypeArchived,
  setTeamModule,
  updateFineType,
  updateModuleConfig,
} from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
let u11: string;

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
  u11 = demo.teams.u11.id;
  await setTeamModule(db, await loadAccessContext(db, demo.users.karen.user.id), u11, "fines", true);
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const kid = (k: keyof typeof demo.kids) => demo.kids[k].id;
const box = async (who: keyof typeof demo.users) => getFineBox(db, await ctxOf(who), u11);

describe("alder", () => {
  it("tæller hele år på dagen", () => {
    expect(ageOn("2015-10-30", "2026-10-29")).toBe(10);
    expect(ageOn("2015-10-30", "2026-10-30")).toBe(11);
    expect(ageOn("2016-02-29", "2027-02-28")).toBe(10);
    expect(ageOn("2016-02-29", "2027-03-01")).toBe(11);
  });
});

describe("bødekasse", () => {
  it("kræver at modulet er slået til", async () => {
    await expect(getFineBox(db, await ctxOf("karen"), demo.teams.u9.id)).rejects.toThrow(/ikke slået til/);
  });

  it("har ingen satser fra start, og kun træner og admin opretter dem", async () => {
    expect((await box("jonas")).types).toEqual([]);
    await expect(createFineType(db, await ctxOf("sofie"), u11, { name: "For sent", amountOre: 1000 })).rejects.toThrow(/Kun trænere/);
    await expect(createFineType(db, await ctxOf("jonas"), u11, { name: " ", amountOre: 1000 })).rejects.toThrow(/Skriv/);
    for (const bad of [0, -5, 1.5, 1_000_001]) {
      await expect(createFineType(db, await ctxOf("jonas"), u11, { name: "X", amountOre: bad })).rejects.toThrow(/Beløbet/);
    }
    const late = await createFineType(db, await ctxOf("jonas"), u11, { name: "For sent til træning", amountOre: 1000 });
    expect((await box("jonas")).types).toEqual([{ id: late.id, name: "For sent til træning", amountOre: 1000, archived: false }]);
    // Mette er træner på U9, men kun forælder på U11 (William): hun kan se satserne, men ikke ændre dem.
    await expect(updateFineType(db, await ctxOf("mette"), late.id, { name: "X", amountOre: 1 })).rejects.toThrow(/Kun trænere/);
    // Ali har ingen tilknytning til U11 og kan slet ikke se holdet.
    await expect(updateFineType(db, await ctxOf("ali"), late.id, { name: "X", amountOre: 1 })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("giver ikke bøder under aldersgrænsen (standard 12 år), og ikke uden fødselsdato", async () => {
    const jonas = await ctxOf("jonas");
    const [type] = (await getFineBox(db, jonas, u11)).types;
    // Kasper er 11, Lukas 10: begge under 12.
    await expect(giveFine(db, jonas, u11, { profileId: kid("kasper"), fineTypeId: type.id })).rejects.toThrow(/under 12 år/);
    await expect(giveFine(db, jonas, u11, { profileId: kid("lukas"), fineTypeId: type.id })).rejects.toThrow(/under 12 år/);
    const players = (await getFineBox(db, jonas, u11)).players;
    expect(players.every((p) => !p.eligible)).toBe(true);
    await sql`update profiles set birth_date = null where id = ${kid("william")}`;
    await expect(giveFine(db, jonas, u11, { profileId: kid("william"), fineTypeId: type.id })).rejects.toThrow(/ingen fødselsdato/);
    await sql`update profiles set birth_date = '2015-09-12' where id = ${kid("william")}`;
    // Spillere fra andre hold kan ikke få bøder.
    await expect(giveFine(db, jonas, u11, { profileId: kid("emma"), fineTypeId: type.id })).rejects.toThrow(/ikke på holdet/);
  });

  it("holdet kan sænke aldersgrænsen, og så gælder den for nye bøder", async () => {
    const jonas = await ctxOf("jonas");
    await expect(updateModuleConfig(db, await ctxOf("sofie"), u11, "fines", { minAge: "11" })).rejects.toBeInstanceOf(ForbiddenError);
    await updateModuleConfig(db, jonas, u11, "fines", { minAge: "11" });
    const [type] = (await getFineBox(db, jonas, u11)).types;
    const kasper = await giveFine(db, jonas, u11, { profileId: kid("kasper"), fineTypeId: type.id });
    expect(kasper).toMatchObject({ description: "For sent til træning", amountOre: 1000, paidAt: null });
    await expect(giveFine(db, jonas, u11, { profileId: kid("lukas"), fineTypeId: type.id })).rejects.toThrow(/under 11 år/);
    const players = (await getFineBox(db, jonas, u11)).players;
    expect(players.filter((p) => p.eligible).map((p) => p.name.split(" ")[0]).sort()).toEqual(["Kasper", "William"]);
  });

  it("en bøde med egen tekst og beløb, og kun af trænere", async () => {
    const jonas = await ctxOf("jonas");
    await expect(giveFine(db, await ctxOf("anne"), u11, { profileId: kid("william"), description: "Mobil i omklædningen", amountOre: 500 })).rejects.toThrow(/Kun trænere/);
    await expect(giveFine(db, jonas, u11, { profileId: kid("william"), description: "", amountOre: 500 })).rejects.toThrow(/Skriv/);
    await expect(giveFine(db, jonas, u11, { profileId: kid("william"), description: "X", amountOre: 0 })).rejects.toThrow(/Beløbet/);
    const f = await giveFine(db, jonas, u11, { profileId: kid("william"), description: "Mobil i omklædningen", amountOre: 500 });
    expect(f.fineTypeId).toBeNull();
  });

  it("en ændret sats rører ikke bøder, der allerede er givet, og en arkiveret sats kan ikke bruges", async () => {
    const jonas = await ctxOf("jonas");
    const [type] = (await getFineBox(db, jonas, u11)).types;
    await updateFineType(db, jonas, type.id, { name: "For sent", amountOre: 2000 });
    const rows = (await getFineBox(db, jonas, u11)).recent;
    expect(rows.find((r) => r.playerName.startsWith("Kasper"))).toMatchObject({ description: "For sent til træning", amountOre: 1000 });
    const f = await giveFine(db, jonas, u11, { profileId: kid("william"), fineTypeId: type.id });
    expect(f).toMatchObject({ description: "For sent", amountOre: 2000 });
    await setFineTypeArchived(db, jonas, type.id, true);
    await expect(giveFine(db, jonas, u11, { profileId: kid("william"), fineTypeId: type.id })).rejects.toThrow(/ikke i brug/);
    expect((await box("sofie")).types).toEqual([]); // forældre ser kun satser i brug
    expect((await box("jonas")).types[0].archived).toBe(true);
  });

  it("forældre ser kun deres eget barns bøder, resten af holdet kun kassen", async () => {
    const anne = await box("anne"); // far/mor til Kasper
    expect(anne.mine.map((m) => m.playerName.split(" ")[0])).toEqual(["Kasper"]);
    expect(anne.players).toEqual([]);
    expect(anne.recent).toEqual([]);
    const sofie = await box("sofie"); // Lukas har ingen bøder
    expect(sofie.mine).toEqual([]);
    expect(sofie.box).toEqual({ count: 3, paidOre: 0, openOre: 1000 + 500 + 2000 });
    const mette = await box("mette"); // William er Mettes barn, og hun er træner på U9, ikke på U11
    expect(mette.mine.map((m) => m.playerName.split(" ")[0])).toEqual(["William", "William"]);
    expect(mette.recent).toEqual([]);
    await expect(getFineBox(db, await ctxOf("ali"), u11)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("betaling og tilbagetrækning kun af trænere, og kassen følger med", async () => {
    const jonas = await ctxOf("jonas");
    const kasper = (await getFineBox(db, jonas, u11)).recent.find((r) => r.playerName.startsWith("Kasper"))!;
    await expect(setFinePaid(db, await ctxOf("anne"), kasper.id, true)).rejects.toThrow(/Kun trænere/);
    await setFinePaid(db, jonas, kasper.id, true);
    expect((await box("sofie")).box).toEqual({ count: 3, paidOre: 1000, openOre: 2500 });
    await setFinePaid(db, jonas, kasper.id, false);
    await setFinePaid(db, jonas, kasper.id, true);
    await expect(cancelFine(db, await ctxOf("anne"), kasper.id)).rejects.toThrow(/Kun trænere/);
    await cancelFine(db, jonas, kasper.id);
    await expect(setFinePaid(db, jonas, kasper.id, true)).rejects.toThrow(/trukket tilbage/);
    expect((await box("sofie")).box).toEqual({ count: 2, paidOre: 0, openOre: 2500 });
    expect((await box("anne")).mine).toEqual([]);
    const trukket = (await box("jonas")).recent.find((r) => r.id === kasper.id)!;
    expect(trukket.cancelled).toBe(true);
  });

  it("voksne på seniorholdet får bøder uden problemer", async () => {
    await setTeamModule(db, await ctxOf("karen"), demo.teams.senior.id, "fines", true);
    const peter = await ctxOf("peter");
    const f = await giveFine(db, peter, demo.teams.senior.id, { profileId: demo.users.niklas.profile.id, description: "Glemte bolde", amountOre: 2500 });
    expect(f.amountOre).toBe(2500);
    const niklas = await getFineBox(db, await ctxOf("niklas"), demo.teams.senior.id);
    expect(niklas.mine.map((m) => m.description)).toEqual(["Glemte bolde"]);
  });
});
