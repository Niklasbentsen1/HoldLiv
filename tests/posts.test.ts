// Nyheder og opslagstavle pr. forening og hold, mod en rigtig Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { addClubMember, createChildProfile, grantClubAdmin, registerUser, createPost, deletePost, listFeed, listPostTargets, setPostPinned, type Deliver } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
const mails: { to: string; subject: string }[] = [];
const deliver: Deliver = {
  baseUrl: "https://holdliv.test",
  mail: async (to, subject) => {
    mails.push({ to, subject });
  },
  sms: null,
};

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  mails.length = 0;
  await sql`delete from notifications`;
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const club = () => `club:${demo.club.id}`;
const u9 = () => `team:${demo.teams.u9.id}`;
const u11 = () => `team:${demo.teams.u11.id}`;
const titles = async (who: keyof typeof demo.users, kind: "news" | "board") => (await listFeed(db, await ctxOf(who), kind)).map((p) => p.title);

describe("hvor man må skrive", () => {
  it("nyheder kun som leder, opslag overalt hvor man hører til", async () => {
    const news = async (who: keyof typeof demo.users) => (await listPostTargets(db, await ctxOf(who), "news")).map((t) => t.key);
    const board = async (who: keyof typeof demo.users) => (await listPostTargets(db, await ctxOf(who), "board")).map((t) => t.key);
    expect(await news("karen")).toContain(club()); // admin
    expect(await news("mette")).toEqual([u9()]); // træner: kun sit hold, ikke foreningen
    expect(await news("ali")).toEqual([]); // forælder
    const parentBoard = await board("sofie"); // mor til Ida (U9) og Lukas (U11)
    expect(parentBoard).toEqual(expect.arrayContaining([club(), u9(), u11()]));
    expect(await board("peter")).not.toContain(u9());
  });
});

describe("nyheder", () => {
  it("afviser dem uden ret, og tomme eller for lange felter", async () => {
    await expect(createPost(db, await ctxOf("ali"), deliver, { kind: "news", scope: u9(), title: "Hej", body: "Tekst" })).rejects.toThrow(/Kun ledelsen/);
    await expect(createPost(db, await ctxOf("mette"), deliver, { kind: "news", scope: club(), title: "Hej", body: "Tekst" })).rejects.toThrow(/Du hører ikke til der|Kun ledelsen/);
    await expect(createPost(db, await ctxOf("mette"), deliver, { kind: "news", scope: u11(), title: "Hej", body: "Tekst" })).rejects.toThrow(/Kun ledelsen/); // forælder på U11
    await expect(createPost(db, await ctxOf("peter"), deliver, { kind: "news", scope: u9(), title: "Hej", body: "Tekst" })).rejects.toThrow(/Du hører ikke til der/);
    const mette = await ctxOf("mette");
    await expect(createPost(db, mette, deliver, { kind: "news", scope: u9(), title: " ", body: "x" })).rejects.toThrow(/overskrift/);
    await expect(createPost(db, mette, deliver, { kind: "news", scope: u9(), title: "x".repeat(121), body: "x" })).rejects.toThrow(/for lang/);
    await expect(createPost(db, mette, deliver, { kind: "news", scope: u9(), title: "x", body: "" })).rejects.toThrow(/tekst/);
  });

  it("holdnyhed ses af holdets familier og træner, og giver besked til dem, ikke til forfatteren", async () => {
    await createPost(db, await ctxOf("mette"), deliver, { kind: "news", scope: u9(), title: "Stævne i marts", body: "Vi tager til Horsens." });
    expect(await titles("niklas", "news")).toContain("Stævne i marts");
    expect(await titles("henrik", "news")).toContain("Stævne i marts"); // far til Alma, U9
    expect(await titles("peter", "news")).not.toContain("Stævne i marts"); // seniortræner, ikke U9
    expect(mails.map((m) => m.to).sort()).toEqual(["ali", "anne", "henrik", "lars", "niklas", "sofie"].map((n) => `${n}@holdliv.test`));
    expect(mails[0].subject).toBe("Nyhed: Stævne i marts");
  });

  it("foreningsnyhed ses af alle medlemmer og forældre, og admin kan fastgøre", async () => {
    const karen = await ctxOf("karen");
    const a = await createPost(db, karen, deliver, { kind: "news", scope: club(), title: "Generalforsamling", body: "Torsdag kl. 19." });
    const b = await createPost(db, karen, deliver, { kind: "news", scope: club(), title: "Nyt klubhus", body: "Det åbner snart.", pinned: true });
    expect(await titles("sofie", "news")).toEqual(expect.arrayContaining(["Generalforsamling", "Nyt klubhus"]));
    expect((await titles("sofie", "news"))[0]).toBe("Nyt klubhus"); // fastgjort først
    await setPostPinned(db, karen, b.id, false);
    await setPostPinned(db, karen, a.id, true);
    expect((await titles("sofie", "news"))[0]).toBe("Generalforsamling");
    await expect(setPostPinned(db, await ctxOf("sofie"), a.id, false)).rejects.toThrow(/Kun ledelsen/);
  });
});

describe("børn med eget login", () => {
  it("kan ikke skrive opslag, heller ikke uden fødselsdato", async () => {
    const karen = await ctxOf("karen");
    for (const [email, birthDate] of [["teen2@holdliv.test", "2030-01-01"], ["nobd2@holdliv.test", undefined]] as const) {
      const u = await registerUser(db, email, { firstName: "Barn", lastName: "Test", birthDate });
      await addClubMember(db, karen, demo.club.id, u.profile.id);
      const ctx = await loadAccessContext(db, u.user.id);
      await expect(createPost(db, ctx, deliver, { kind: "board", scope: club(), title: "Hej", body: "Hej" })).rejects.toThrow(/Kun voksne/);
      expect(await listPostTargets(db, ctx, "board")).toEqual([]);
    }
  });
});

describe("ledelsen uden fødselsdato", () => {
  it("kan stadig skrive nyheder", async () => {
    const karen = await ctxOf("karen");
    const u = await registerUser(db, "nobd-admin@holdliv.test", { firstName: "Admin", lastName: "Uden" });
    await grantClubAdmin(db, karen, demo.club.id, u.profile.id);
    const ctx = await loadAccessContext(db, u.user.id);
    expect((await listPostTargets(db, ctx, "news")).length).toBeGreaterThan(0);
    await createPost(db, ctx, deliver, { kind: "news", scope: club(), title: "Fra ny admin", body: "Hej" });
    expect(await titles("karen", "news")).toContain("Fra ny admin");
  });
});

describe("forældre uden fødselsdato", () => {
  it("kan bruge opslagstavlen", async () => {
    const u = await registerUser(db, "nobd-parent@holdliv.test", { firstName: "Far", lastName: "Uden" });
    const karen = await ctxOf("karen");
    await addClubMember(db, karen, demo.club.id, u.profile.id);
    await createChildProfile(db, await loadAccessContext(db, u.user.id), { firstName: "Barn", lastName: "Uden", birthDate: "2018-01-01" });
    const ctx0 = await loadAccessContext(db, u.user.id);
    await createPost(db, ctx0, deliver, { kind: "board", scope: club(), title: "Forælder", body: "Hej" });
    expect(await titles("karen", "board")).toContain("Forælder");
  });
});

describe("opslagstavlen", () => {
  it("forældre kan skrive, opslaget udløber og giver ingen besked", async () => {
    const sofie = await ctxOf("sofie");
    const p = await createPost(db, sofie, deliver, { kind: "board", scope: u9(), title: "Sælger fodboldstøvler", body: "Str. 33, næsten nye.", expiresInDays: 7 });
    expect(mails).toEqual([]);
    expect(await titles("ali", "board")).toContain("Sælger fodboldstøvler");
    expect(await titles("ali", "news")).not.toContain("Sælger fodboldstøvler");
    await sql`update posts set expires_at = now() - interval '1 minute' where id = ${p.id}`;
    expect(await titles("ali", "board")).not.toContain("Sælger fodboldstøvler");
    await expect(createPost(db, sofie, deliver, { kind: "board", scope: u9(), title: "x", body: "x", expiresInDays: 0 })).rejects.toThrow(/dage/);
    await expect(createPost(db, sofie, deliver, { kind: "board", scope: u9(), title: "x", body: "x", pinned: true })).rejects.toThrow(/Kun ledelsen/);
    await expect(createPost(db, await ctxOf("peter"), deliver, { kind: "board", scope: u9(), title: "x", body: "x" })).rejects.toThrow(/ikke til der/);
  });

  it("forfatteren og ledelsen kan slette, andre ikke, og fremmede kan ikke se, at opslaget findes", async () => {
    const p = await createPost(db, await ctxOf("ali"), deliver, { kind: "board", scope: u9(), title: "Søger lift", body: "Til kampen lørdag." });
    await expect(deletePost(db, await ctxOf("anne"), p.id)).rejects.toThrow(/må du ikke/);
    await expect(deletePost(db, await ctxOf("peter"), p.id)).rejects.toThrow(/findes ikke/);
    await deletePost(db, await ctxOf("ali"), p.id);
    expect(await titles("anne", "board")).not.toContain("Søger lift");
    const q = await createPost(db, await ctxOf("ali"), deliver, { kind: "board", scope: u9(), title: "Fundet trøje", body: "Hos træneren." });
    await deletePost(db, await ctxOf("mette"), q.id); // træneren
    expect(await titles("mette", "board")).not.toContain("Fundet trøje");
  });
});
