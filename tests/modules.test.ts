// Modulmotoren mod en rigtig Postgres. Bruger et prøveregister, så motoren testes uden de rigtige moduler.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { MODULES, defaultConfig, parseConfig, type Registry } from "../src/modules/registry";
import {
  listEnabledModules,
  listTeamModules,
  moduleMatrix,
  saveModuleMatrix,
  requireModule,
  setModuleForTeams,
  setTeamModule,
  updateModuleConfig,
} from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;

const REG: Registry = {
  fines: { ...MODULES.fines, available: true },
  carpool: { ...MODULES.carpool, available: true },
  tasks: { ...MODULES.tasks, available: false },
};

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);

describe("indstillinger", () => {
  it("udfylder standardværdier og afviser ugyldige tal", () => {
    expect(defaultConfig(MODULES.fines)).toEqual({ minAge: 12 });
    expect(parseConfig(MODULES.fines, {})).toEqual({ minAge: 12 });
    expect(parseConfig(MODULES.fines, { minAge: "10", ukendt: 1 })).toEqual({ minAge: 10 });
    expect(() => parseConfig(MODULES.fines, { minAge: "3" })).toThrow(/mellem 6 og 18/);
    expect(() => parseConfig(MODULES.fines, { minAge: "10,5" })).toThrow();
  });
});

describe("afkrydsningsfelter", () => {
  const withBool = { ...MODULES.fines, fields: [{ key: "visAlle", label: "Vis alle", type: "bool" as const, default: true }] };
  it("et manglende felt fra en formular betyder fra, fra databasen betyder standard", () => {
    expect(parseConfig(withBool, {}, "form")).toEqual({ visAlle: false });
    expect(parseConfig(withBool, { visAlle: "on" }, "form")).toEqual({ visAlle: true });
    expect(parseConfig(withBool, {}, "stored")).toEqual({ visAlle: true });
    expect(parseConfig(withBool, { visAlle: false }, "stored")).toEqual({ visAlle: false });
  });

  it("kan slås fra via en formular og huskes", async () => {
    const reg: Registry = { fines: { ...withBool, available: true } };
    const admin = await ctxOf("karen");
    await setTeamModule(db, admin, demo.teams.senior.id, "fines", true, reg);
    expect((await requireModule(db, admin, demo.teams.senior.id, "fines", reg)).config).toEqual({ visAlle: true });
    await updateModuleConfig(db, admin, demo.teams.senior.id, "fines", {}, reg);
    expect((await requireModule(db, admin, demo.teams.senior.id, "fines", reg)).config).toEqual({ visAlle: false });
  });
});

describe("modulmotor", () => {
  it("har alle moduler slukket til at begynde med", async () => {
    const admin = await ctxOf("karen");
    expect(await listEnabledModules(db, admin, demo.teams.u9.id, REG)).toEqual([]);
    await expect(requireModule(db, admin, demo.teams.u9.id, "fines", REG)).rejects.toThrow(/ikke slået til/);
  });

  it("kun foreningens admin slår moduler til og fra", async () => {
    const coach = await ctxOf("mette");
    await expect(setTeamModule(db, coach, demo.teams.u9.id, "carpool", true, REG)).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await ctxOf("karen");
    await setTeamModule(db, admin, demo.teams.u9.id, "carpool", true, REG);
    expect((await listEnabledModules(db, coach, demo.teams.u9.id, REG)).map((m) => m.key)).toEqual(["carpool"]);
  });

  it("er pr. hold: andre hold påvirkes ikke", async () => {
    const admin = await ctxOf("karen");
    expect(await listEnabledModules(db, admin, demo.teams.u11.id, REG)).toEqual([]);
    await expect(requireModule(db, admin, demo.teams.u11.id, "carpool", REG)).rejects.toThrow();
    await expect(requireModule(db, admin, demo.teams.u9.id, "carpool", REG)).resolves.toBeTruthy();
  });

  it("kan ikke slå et modul til, der ikke er bygget, og afviser ukendte", async () => {
    const admin = await ctxOf("karen");
    await expect(setTeamModule(db, admin, demo.teams.u9.id, "tasks", true, REG)).rejects.toThrow(/ikke klar/);
    await expect(setTeamModule(db, admin, demo.teams.u9.id, "findes-ikke", true, REG)).rejects.toThrow(/Ukendt/);
  });

  it("kun holdets egne kan se holdets moduler", async () => {
    const outsider = await ctxOf("jonas"); // træner på U11, ikke på U9
    await expect(listTeamModules(db, outsider, demo.teams.u9.id, REG)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireModule(db, outsider, demo.teams.u9.id, "carpool", REG)).rejects.toBeInstanceOf(ForbiddenError);
    const parent = await ctxOf("niklas"); // far til Emma på U9
    expect((await listEnabledModules(db, parent, demo.teams.u9.id, REG)).map((m) => m.key)).toEqual(["carpool"]);
  });

  it("træneren stiller indstillinger, men det gør forældre ikke", async () => {
    const admin = await ctxOf("karen");
    await setTeamModule(db, admin, demo.teams.u9.id, "fines", true, REG);
    const coach = await ctxOf("mette");
    await updateModuleConfig(db, coach, demo.teams.u9.id, "fines", { minAge: "9" }, REG);
    const { config } = await requireModule(db, coach, demo.teams.u9.id, "fines", REG);
    expect(config).toEqual({ minAge: 9 });
    await expect(updateModuleConfig(db, coach, demo.teams.u9.id, "fines", { minAge: "2" }, REG)).rejects.toThrow();
    const parent = await ctxOf("ali"); // far til Noor på U9
    await expect(updateModuleConfig(db, parent, demo.teams.u9.id, "fines", { minAge: "9" }, REG)).rejects.toBeInstanceOf(ForbiddenError);
    const otherCoach = await ctxOf("jonas");
    await expect(updateModuleConfig(db, otherCoach, demo.teams.u9.id, "fines", { minAge: "9" }, REG)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("husker indstillingerne, når et modul slås fra og til igen", async () => {
    const admin = await ctxOf("karen");
    await setTeamModule(db, admin, demo.teams.u9.id, "fines", false, REG);
    await expect(requireModule(db, admin, demo.teams.u9.id, "fines", REG)).rejects.toThrow(/ikke slået til/);
    await setTeamModule(db, admin, demo.teams.u9.id, "fines", true, REG);
    expect((await requireModule(db, admin, demo.teams.u9.id, "fines", REG)).config).toEqual({ minAge: 9 });
  });

  it("slår et modul til for flere hold ad gangen og viser det i oversigten", async () => {
    const admin = await ctxOf("karen");
    const n = await setModuleForTeams(db, admin, demo.club.id, "carpool", [demo.teams.u11.id, demo.teams.senior.id], true, REG);
    expect(n).toBe(2);
    const m = await moduleMatrix(db, admin, demo.club.id, REG);
    const row = (name: string) => m.teams.find((t) => t.name === name)!;
    expect(row("U9 piger").enabled).toMatchObject({ carpool: true, fines: true, tasks: false });
    expect(row("U11 drenge").enabled).toMatchObject({ carpool: true, fines: false });
    await setModuleForTeams(db, admin, demo.club.id, "carpool", [demo.teams.senior.id], false, REG);
    expect((await moduleMatrix(db, admin, demo.club.id, REG)).teams.find((t) => t.name === "Senior herrer")!.enabled.carpool).toBe(false);
  });

  it("afviser flere hold, hvis ét hører til en anden forening, og kræver admin", async () => {
    const admin = await ctxOf("karen");
    await expect(setModuleForTeams(db, admin, demo.club.id, "carpool", ["00000000-0000-0000-0000-000000000000"], true, REG)).rejects.toThrow(/foreningen/);
    const coach = await ctxOf("mette");
    await expect(setModuleForTeams(db, coach, demo.club.id, "carpool", [demo.teams.u9.id], false, REG)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(moduleMatrix(db, coach, demo.club.id, REG)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("afviser indstillinger for et slukket modul", async () => {
    const coach = await ctxOf("jonas");
    await expect(updateModuleConfig(db, coach, demo.teams.u11.id, "fines", { minAge: "10" }, REG)).rejects.toThrow(/ikke slået til/);
  });

  it("gemmer oversigten i ét hug, og intet gemmes hvis noget fejler", async () => {
    const admin = await ctxOf("karen");
    const all = [demo.teams.u9.id, demo.teams.u11.id, demo.teams.senior.id];
    await saveModuleMatrix(db, admin, demo.club.id, all, { carpool: [demo.teams.u9.id], fines: [] }, REG);
    let m = await moduleMatrix(db, admin, demo.club.id, REG);
    expect(m.teams.map((t) => [t.name, t.enabled.carpool, t.enabled.fines])).toEqual([
      ["Senior herrer", false, false],
      ["U11 drenge", false, false],
      ["U9 piger", true, false],
    ]);
    await expect(
      saveModuleMatrix(db, admin, demo.club.id, all, { carpool: all, tasks: [demo.teams.u9.id] }, REG),
    ).rejects.toThrow(/ikke klar/);
    m = await moduleMatrix(db, admin, demo.club.id, REG);
    expect(m.teams.filter((t) => t.enabled.carpool).map((t) => t.name)).toEqual(["U9 piger"]);
    const coach = await ctxOf("mette");
    await expect(saveModuleMatrix(db, coach, demo.club.id, all, { carpool: all }, REG)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
