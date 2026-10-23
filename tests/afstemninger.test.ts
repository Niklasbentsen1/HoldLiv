// Afstemninger mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { closePoll, createPoll, deletePoll, listPolls, setTeamModule, vote, withdrawVote } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
let u9: string;

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
  u9 = demo.teams.u9.id;
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users, now?: Date) => loadAccessContext(db, demo.users[key].user.id, now);
const kid = (k: keyof typeof demo.kids) => demo.kids[k].id;
const q = async (who: keyof typeof demo.users) => (await listPolls(db, await ctxOf(who), u9)).polls;

describe("afstemninger", () => {
  it("kræver at modulet er slået til, og at man er på holdet", async () => {
    await expect(listPolls(db, await ctxOf("mette"), u9)).rejects.toThrow(/ikke slået til/);
    await setTeamModule(db, await ctxOf("karen"), u9, "polls", true);
    await expect(listPolls(db, await ctxOf("peter"), u9)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lader kun trænere og admin starte, med 2 til 10 forskellige svar", async () => {
    const input = { question: "Sæsonafslutning?", options: ["Fredag", "Lørdag"] };
    await expect(createPoll(db, await ctxOf("ali"), u9, input)).rejects.toThrow(/Kun trænere/);
    const mette = await ctxOf("mette");
    await expect(createPoll(db, mette, u9, { ...input, question: " " })).rejects.toThrow(/spørgsmål/);
    await expect(createPoll(db, mette, u9, { ...input, options: ["Kun ét", " "] })).rejects.toThrow(/valgmuligheder/);
    await expect(createPoll(db, mette, u9, { ...input, options: Array.from({ length: 11 }, (_, i) => `V${i}`) })).rejects.toThrow(/valgmuligheder/);
    await expect(createPoll(db, mette, u9, { ...input, options: ["Ja", "ja"] })).rejects.toThrow(/forskellige/);
    await expect(createPoll(db, mette, u9, { ...input, closesAt: new Date(Date.now() - 1000) })).rejects.toThrow(/fortiden/);
    await createPoll(db, mette, u9, input);
    expect((await q("ali"))).toHaveLength(1);
  });

  it("skjuler resultatet for dem, der ikke har stemt, indtil de stemmer", async () => {
    const [p] = await q("ali");
    expect(p.showResults).toBe(false);
    expect(p.options.every((o) => o.count === null)).toBe(true);
    // Ali kan stemme for Noor (sit barn), men ikke for Emma.
    const ali = await ctxOf("ali");
    await expect(vote(db, ali, p.id, [p.options[0].id], kid("emma"))).rejects.toThrow(/dig selv og dine børn/);
    await vote(db, ali, p.id, [p.options[0].id], kid("noor"));
    const [after] = await q("ali");
    expect(after.showResults).toBe(true);
    expect(after.options[0].count).toBe(1);
    expect(after.options[0].names).toEqual([]); // forældre ser aldrig navne
  });

  it("giver én stemme pr. spiller, som kan skiftes og trækkes tilbage", async () => {
    const ali = await ctxOf("ali");
    const [p] = await q("ali");
    await vote(db, ali, p.id, [p.options[1].id], kid("noor"));
    const [changed] = await q("ali");
    expect(changed.options.map((o) => o.count)).toEqual([0, 1]);
    await expect(vote(db, ali, p.id, [p.options[0].id, p.options[1].id], kid("noor"))).rejects.toThrow(/kun vælge ét/);
    await expect(vote(db, ali, p.id, [], kid("noor"))).rejects.toThrow(/mindst ét/);
    await expect(vote(db, ali, p.id, ["00000000-0000-0000-0000-000000000000"], kid("noor"))).rejects.toThrow(/hører ikke/);
    await withdrawVote(db, ali, p.id, kid("noor"));
    expect((await q("mette"))[0].options.map((o) => o.count)).toEqual([0, 0]);
  });

  it("er begrænset til holdets medlemmer", async () => {
    const [p] = await q("mette");
    // William er på U11, ikke U9.
    await expect(vote(db, await ctxOf("mette"), p.id, [p.options[0].id], kid("william"))).rejects.toThrow(/Kun medlemmer af holdet/);
  });

  it("viser trænerne hvem der stemte hvad, undtagen i en anonym afstemning", async () => {
    const mette = await ctxOf("mette");
    const open = await createPoll(db, mette, u9, { question: "Trøjefarve?", options: ["Rød", "Blå"] });
    const anon = await createPoll(db, mette, u9, { question: "Hemmelig?", options: ["Ja", "Nej"], anonymous: true });
    const list = await q("mette");
    const o = list.find((p) => p.id === open.id)!;
    const a = list.find((p) => p.id === anon.id)!;
    await vote(db, await ctxOf("ali"), o.id, [o.options[0].id], kid("noor"));
    await vote(db, await ctxOf("ali"), a.id, [a.options[1].id], kid("noor"));
    const after = await q("mette");
    expect(after.find((p) => p.id === open.id)!.options[0].names).toEqual(["Noor Hassan"]);
    expect(after.find((p) => p.id === anon.id)!.options[1].names).toEqual([]);
    expect(after.find((p) => p.id === anon.id)!.options[1].count).toBe(1);
  });

  it("lukker ved sluttidspunktet og når træneren lukker den, og tillader ikke flere stemmer", async () => {
    const mette = await ctxOf("mette");
    const now = new Date();
    const timed = await createPoll(db, mette, u9, { question: "Tidsbegrænset?", options: ["A", "B"], closesAt: new Date(now.getTime() + 60_000) });
    const [t] = (await q("mette")).filter((p) => p.id === timed.id);
    const later = await ctxOf("ali", new Date(now.getTime() + 120_000));
    await expect(vote(db, later, t.id, [t.options[0].id], kid("noor"))).rejects.toThrow(/lukket/);
    expect((await listPolls(db, later, u9)).polls.find((p) => p.id === timed.id)!.open).toBe(false);

    const manual = await createPoll(db, mette, u9, { question: "Lukkes manuelt?", options: ["A", "B"] });
    await expect(closePoll(db, await ctxOf("ali"), manual.id)).rejects.toThrow(/Kun trænere/);
    await closePoll(db, mette, manual.id);
    await expect(closePoll(db, mette, manual.id)).rejects.toThrow(/allerede lukket/);
    const [m] = (await q("ali")).filter((p) => p.id === manual.id);
    await expect(vote(db, await ctxOf("ali"), manual.id, [m.options[0].id], kid("noor"))).rejects.toThrow(/lukket/);
    await expect(withdrawVote(db, await ctxOf("ali"), manual.id, kid("noor"))).rejects.toThrow(/lukket/);
    // Resultatet vises, når den er lukket, også for dem der ikke stemte.
    expect(m.showResults).toBe(true);
  });

  it("tillader flere svar, når afstemningen er sat til det", async () => {
    const mette = await ctxOf("mette");
    const p = await createPoll(db, mette, u9, { question: "Hvem vil med?", options: ["Bus", "Bil", "Cykel"], multiple: true });
    const [view] = (await q("mette")).filter((x) => x.id === p.id);
    await vote(db, await ctxOf("ali"), p.id, [view.options[0].id, view.options[2].id], kid("noor"));
    const [after] = (await q("mette")).filter((x) => x.id === p.id);
    expect(after.options.map((o) => o.count)).toEqual([1, 0, 1]);
    expect(after.voterCount).toBe(1);
  });

  it("sletter afstemningen med stemmer, kun for trænere", async () => {
    const mette = await ctxOf("mette");
    const [p] = await q("mette");
    await expect(deletePoll(db, await ctxOf("ali"), p.id)).rejects.toThrow(/Kun trænere/);
    await deletePoll(db, mette, p.id);
    expect((await q("mette")).some((x) => x.id === p.id)).toBe(false);
  });
});
