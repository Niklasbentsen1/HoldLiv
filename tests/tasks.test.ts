// Frugt og opgaver mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import {
  assignTask,
  claimTask,
  createFruitList,
  createTask,
  deleteTask,
  distributeOpenTasks,
  listFruitCandidates,
  listTasks,
  releaseTask,
  respondToEvent,
  setEventCancelled,
  setTaskDone,
  setTeamModule,
} from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
let u9: string;

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
  u9 = demo.teams.u9.id;
  await setTeamModule(db, await loadAccessContext(db, demo.users.karen.user.id), u9, "tasks", true);
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const kid = (k: keyof typeof demo.kids) => demo.kids[k].id;
const names = async (who: keyof typeof demo.users = "mette") => (await listTasks(db, await ctxOf(who), u9)).open;

describe("opgaver", () => {
  it("kræver at modulet er slået til", async () => {
    await expect(listTasks(db, await ctxOf("karen"), demo.teams.u11.id)).rejects.toThrow(/ikke slået til/);
    await expect(listTasks(db, await ctxOf("jonas"), u9)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("kun trænere og admin opretter og sletter opgaver", async () => {
    await expect(createTask(db, await ctxOf("ali"), u9, { kind: "task", title: "Kridt banen" })).rejects.toThrow(/Kun trænere/);
    await expect(createTask(db, await ctxOf("mette"), u9, { kind: "task", title: "  " })).rejects.toThrow(/Skriv/);
    await expect(createTask(db, await ctxOf("mette"), u9, { kind: "task", title: "X", eventId: demo.events.seniorTraining.id })).rejects.toThrow(/ikke til holdet/);
    const t = await createTask(db, await ctxOf("mette"), u9, { kind: "task", title: "Midlertidig" });
    await expect(deleteTask(db, await ctxOf("ali"), t.id)).rejects.toThrow(/Kun trænere/);
    await deleteTask(db, await ctxOf("mette"), t.id);
  });

  it("laver en frugtliste og fordeler den retfærdigt på familierne", async () => {
    const mette = await ctxOf("mette");
    const cands = await listFruitCandidates(db, mette, u9, 5);
    expect(cands).toHaveLength(5);
    expect(await createFruitList(db, mette, u9, cands.map((c) => c.id))).toBe(5);
    // Samme aktiviteter igen giver ingen nye opgaver.
    expect(await createFruitList(db, mette, u9, cands.map((c) => c.id))).toBe(0);
    const open = (await names()).filter((t) => t.kind === "fruit");
    expect(open).toHaveLength(5);
    // Fem familier (Freja har to værger, men er én familie), fem opgaver: alle får én.
    expect(new Set(open.map((t) => t.assignee!.name)).size).toBe(5);
    expect((await listFruitCandidates(db, mette, u9, 5)).map((c) => c.id)).not.toContain(cands[0].id);
  });

  it("næste fordeling tager højde for hvad familierne allerede har haft", async () => {
    const mette = await ctxOf("mette");
    const [more] = await listFruitCandidates(db, mette, u9, 1);
    await createFruitList(db, mette, u9, [more.id]);
    const loads = (await listTasks(db, mette, u9)).families;
    expect(loads.map((f) => f.fruit).sort()).toEqual([1, 1, 1, 1, 2]);
  });

  it("en forælder kan tage en ledig opgave for sit barn, men ikke en der er taget, og ikke for andres børn", async () => {
    const mette = await ctxOf("mette");
    const t = await createTask(db, mette, u9, { kind: "task", title: "Kridt banen", note: "Kridtet står i skuret" });
    const ali = await ctxOf("ali");
    expect((await listTasks(db, ali, u9)).myFamilies.map((f) => f.name)).toEqual(["Noor Hassan"]);
    expect((await names("ali")).find((x) => x.id === t.id)!.canClaim).toBe(true);
    await expect(claimTask(db, ali, t.id, kid("alma"))).rejects.toThrow(/må ikke/);
    await expect(claimTask(db, ali, t.id, demo.kids.kasper.id)).rejects.toThrow(/må ikke|ikke på holdet/);
    await claimTask(db, ali, t.id, kid("noor"));
    await expect(claimTask(db, await ctxOf("henrik"), t.id, kid("alma"))).rejects.toThrow(/allerede taget/);
    const mine = (await names("ali")).find((x) => x.id === t.id)!;
    expect(mine).toMatchObject({ mine: true, canRelease: true, canComplete: true, canClaim: false });
    expect((await names("henrik")).find((x) => x.id === t.id)).toMatchObject({ mine: false, canRelease: false, canComplete: false });
  });

  it("to familier kan ikke tage den samme opgave samtidig", async () => {
    const t = await createTask(db, await ctxOf("mette"), u9, { kind: "task", title: "Bær bolde" });
    const results = await Promise.allSettled([
      claimTask(db, await ctxOf("sofie"), t.id, kid("ida")),
      claimTask(db, await ctxOf("henrik"), t.id, kid("alma")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await deleteTask(db, await ctxOf("mette"), t.id);
  });

  it("kun familien eller træneren gør opgaven færdig eller giver den fra sig", async () => {
    const mette = await ctxOf("mette");
    const t = (await names()).find((x) => x.title === "Kridt banen")!;
    await expect(setTaskDone(db, await ctxOf("henrik"), t.id, true)).rejects.toThrow(/ikke jeres/);
    await expect(releaseTask(db, await ctxOf("henrik"), t.id)).rejects.toThrow(/ikke jeres/);
    await setTaskDone(db, await ctxOf("ali"), t.id, true);
    const list = await listTasks(db, mette, u9);
    expect(list.open.find((x) => x.id === t.id)).toBeUndefined();
    expect(list.done.map((x) => x.title)).toContain("Kridt banen");
    await expect(releaseTask(db, await ctxOf("ali"), t.id)).rejects.toThrow(/udført/);
    await setTaskDone(db, mette, t.id, false);
    await releaseTask(db, await ctxOf("ali"), t.id);
    expect((await names()).find((x) => x.id === t.id)!.assignee).toBeNull();
  });

  it("træneren kan skrive en opgave på en bestemt familie, men kun en spiller på holdet", async () => {
    const mette = await ctxOf("mette");
    const t = (await names()).find((x) => x.title === "Kridt banen")!;
    await expect(assignTask(db, await ctxOf("ali"), t.id, kid("noor"))).rejects.toThrow(/Kun trænere/);
    await expect(assignTask(db, mette, t.id, demo.kids.kasper.id)).rejects.toThrow(/ikke på holdet/);
    await assignTask(db, mette, t.id, kid("freja"));
    expect((await names()).find((x) => x.id === t.id)!.assignee!.name).toBe("Freja Møller");
    await assignTask(db, mette, t.id, null);
  });

  it("fordeler ikke til en familie, der har meldt fra til aktiviteten, og springer aflyste over", async () => {
    const mette = await ctxOf("mette");
    const [e1, e2] = await listFruitCandidates(db, mette, u9, 2);
    const a = await createTask(db, mette, u9, { kind: "task", title: "Oprydning", eventId: e1.id });
    const b = await createTask(db, mette, u9, { kind: "task", title: "Oprydning", eventId: e2.id });
    // Alle familier undtagen Henriks (Alma) melder fra til e1, så Alma må tage den.
    for (const [who, child] of [["niklas", "emma"], ["sofie", "ida"], ["ali", "noor"], ["anne", "freja"]] as const) {
      await respondToEvent(db, await ctxOf(who), e1.id, kid(child), "no");
    }
    await setEventCancelled(db, mette, e2.id, true);
    expect(await distributeOpenTasks(db, mette, u9, "task")).toBeGreaterThanOrEqual(2);
    const open = await names();
    // Opgaven på den aflyste aktivitet er skjult og blev ikke fordelt.
    expect(open.find((x) => x.id === b.id)).toBeUndefined();
    const free = (await sql`select assignee_profile_id from team_tasks where id = ${b.id}`)[0];
    expect(free.assignee_profile_id).toBeNull();
    expect(open.find((x) => x.id === a.id)!.assignee!.name).toBe("Alma Juul");
    await setEventCancelled(db, mette, e2.id, false);
  });

  it("kun trænere fordeler, og fordelingen rører ikke opgaver der allerede har en familie", async () => {
    await expect(distributeOpenTasks(db, await ctxOf("ali"), u9)).rejects.toThrow(/Kun trænere/);
    const mette = await ctxOf("mette");
    const before = JSON.stringify((await names()).map((t) => [t.id, t.assignee?.name]));
    await distributeOpenTasks(db, mette, u9);
    const after = (await names()).map((t) => [t.id, t.assignee?.name]);
    for (const [id, name] of JSON.parse(before) as [string, string | undefined][]) {
      if (name) expect(after.find(([i]) => i === id)![1]).toBe(name);
    }
  });

  it("to samtidige frugtlister giver ikke dobbelte opgaver, og frugt hører ikke til forældremøder", async () => {
    const mette = await ctxOf("mette");
    const [e] = await listFruitCandidates(db, mette, u9, 1);
    const results = await Promise.all([createFruitList(db, mette, u9, [e.id]), createFruitList(db, mette, u9, [e.id])]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    const [{ n }] = await sql`select count(*)::int as n from team_tasks where event_id = ${e.id} and kind = 'fruit'`;
    expect(n).toBe(1);
    const meeting = (await sql`select id from events where team_id = ${u9} and type = 'other' and starts_at > now() limit 1`)[0];
    expect(meeting).toBeTruthy();
    await expect(createFruitList(db, mette, u9, [meeting.id])).rejects.toThrow(/træninger og kampe/);
    expect((await listFruitCandidates(db, mette, u9, 50)).map((c) => c.id)).not.toContain(meeting.id);
  });

  it("en ny familie på holdet starter ikke på nul og får ikke alle de næste frugtdage", async () => {
    const admin = await ctxOf("karen");
    const peter = await ctxOf("peter");
    const senior = demo.teams.senior.id;
    await setTeamModule(db, admin, senior, "tasks", true);
    const events = await listFruitCandidates(db, peter, senior, 12);
    expect(events.length).toBeGreaterThanOrEqual(12);
    // Fem spillere, ti frugtdage: to hver.
    await createFruitList(db, peter, senior, events.slice(0, 10).map((e) => e.id));
    expect((await listTasks(db, peter, senior)).families.map((f) => f.fruit)).toEqual([2, 2, 2, 2, 2]);
    // Mette kommer på holdet som spiller og får højst én af de næste to.
    await sql`insert into team_members(team_id, profile_id, role) values (${senior}, ${demo.users.mette.profile.id}, 'player')`;
    await createFruitList(db, peter, senior, events.slice(10, 12).map((e) => e.id));
    const fam = (await listTasks(db, peter, senior)).families;
    expect(fam.find((f) => f.name.startsWith("Mette"))!.fruit).toBe(1);
    expect(fam.map((f) => f.fruit).sort()).toEqual([1, 2, 2, 2, 2, 3]);
  });

  it("fordeler ikke opgaver til aktiviteter der er overstået", async () => {
    const mette = await ctxOf("mette");
    const past = (await sql`select id from events where team_id = ${u9} and starts_at < now() and cancelled_at is null limit 1`)[0];
    const t = await createTask(db, mette, u9, { kind: "task", title: "Gammel", eventId: past.id });
    await distributeOpenTasks(db, mette, u9, "task");
    expect((await sql`select assignee_profile_id from team_tasks where id = ${t.id}`)[0].assignee_profile_id).toBeNull();
    await deleteTask(db, mette, t.id);
  });

  it("søskende på samme hold er én familie", async () => {
    // Lukas og Kasper har ikke samme værger i demoen, så lav et søskendepar på U9: Anne har Freja og Kasper.
    await sql`insert into team_members(team_id, profile_id, role) values (${u9}, ${kid("kasper")}, 'player')`;
    const fam = (await listTasks(db, await ctxOf("mette"), u9)).families.map((f) => f.name);
    expect(fam).toContain("Freja Møller og Kasper");
    expect(fam.filter((n) => n.includes("Kasper"))).toHaveLength(1);
  });
});
