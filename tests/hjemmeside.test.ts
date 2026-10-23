// Den offentlige hjemmeside mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { createEvent, createPost, deletePost, getPublicSite, saveSiteSettings, saveSignupSettings, setEventCancelled, setPostPublic, MAX_SITE_INTRO, type Deliver } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
let clubId: string;
const deliver: Deliver = { mail: async () => {}, sms: null, baseUrl: "http://test" };
const DAY = 86_400_000;

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
  clubId = demo.club.id;
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const base = { enabled: true, intro: "Velkommen", contact: "formand@skovby-if.test", showTeams: true, showCalendar: true };

describe("hjemmeside", () => {
  it("er slået fra som standard og findes ikke for ukendte adresser", async () => {
    expect(await getPublicSite(db, "skovby-if")).toBeNull();
    expect(await getPublicSite(db, "findes-ikke")).toBeNull();
    expect(await getPublicSite(db, "../../etc")).toBeNull();
  });

  it("har kalenderen slået fra, til foreningen selv tænder den", async () => {
    const { clubs } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const [c] = await db.select().from(clubs).where(eq(clubs.id, clubId));
    expect(c.siteShowCalendar).toBe(false);
    expect(c.siteEnabled).toBe(false);
  });

  it("lader kun admin ændre indstillingerne", async () => {
    for (const k of ["mette", "sofie", "ali"] as const) await expect(saveSiteSettings(db, await ctxOf(k), clubId, base)).rejects.toBeInstanceOf(ForbiddenError);
    const karen = await ctxOf("karen");
    await expect(saveSiteSettings(db, karen, clubId, { ...base, intro: "x".repeat(MAX_SITE_INTRO + 1) })).rejects.toThrow(/tegn/);
    await saveSiteSettings(db, karen, clubId, base);
    const site = (await getPublicSite(db, "skovby-if"))!;
    expect(site.clubName).toBe("Skovby IF");
    expect(site.intro).toBe("Velkommen");
    expect(site.teams?.length).toBeGreaterThan(0);
  });

  it("viser indmeldelseslinket kun når indmeldelse er åben", async () => {
    const karen = await ctxOf("karen");
    await saveSignupSettings(db, karen, clubId, { enabled: false, minAge: null, maxAge: null, terms: null });
    expect((await getPublicSite(db, "skovby-if"))!.signupOpen).toBe(false);
    await saveSignupSettings(db, karen, clubId, { enabled: true, minAge: null, maxAge: null, terms: null });
    expect((await getPublicSite(db, "skovby-if"))!.signupOpen).toBe(true);
  });

  it("viser kun nyheder, ledelsen har markeret, og aldrig hold- eller opslagstavleindlæg", async () => {
    const karen = await ctxOf("karen");
    const mette = await ctxOf("mette");
    const priv = await createPost(db, karen, deliver, { kind: "news", scope: `club:${clubId}`, title: "Kun til medlemmer", body: "Intern" });
    const open = await createPost(db, karen, deliver, { kind: "news", scope: `club:${clubId}`, title: "Åben nyhed", body: "Alle må læse", publicOnSite: true });
    await createPost(db, mette, deliver, { kind: "news", scope: `team:${demo.teams.u9.id}`, title: "Holdnyhed", body: "Kun for U9" });
    await createPost(db, karen, deliver, { kind: "board", scope: `club:${clubId}`, title: "Opslag", body: "Sælges" });
    let titles = (await getPublicSite(db, "skovby-if"))!.news.map((n) => n.title);
    expect(titles).toEqual(["Åben nyhed"]);

    await setPostPublic(db, karen, priv.id, true);
    titles = (await getPublicSite(db, "skovby-if"))!.news.map((n) => n.title);
    expect(titles).toContain("Kun til medlemmer");
    await setPostPublic(db, karen, priv.id, false);
    await deletePost(db, karen, open.id);
    expect((await getPublicSite(db, "skovby-if"))!.news).toHaveLength(0);
  });

  it("afviser at gøre hold-nyheder, opslag eller andres nyheder offentlige", async () => {
    const karen = await ctxOf("karen");
    const mette = await ctxOf("mette");
    await expect(createPost(db, mette, deliver, { kind: "news", scope: `team:${demo.teams.u9.id}`, title: "x", body: "y", publicOnSite: true })).rejects.toThrow(/hjemmesiden/);
    await expect(createPost(db, karen, deliver, { kind: "board", scope: `club:${clubId}`, title: "x", body: "y", publicOnSite: true })).rejects.toThrow(/hjemmesiden/);
    const team = await createPost(db, mette, deliver, { kind: "news", scope: `team:${demo.teams.u9.id}`, title: "Holdnyhed 2", body: "y" });
    await expect(setPostPublic(db, karen, team.id, true)).rejects.toThrow(/foreningens egne/);
    const club = await createPost(db, karen, deliver, { kind: "news", scope: `club:${clubId}`, title: "Intern", body: "y" });
    await expect(setPostPublic(db, mette, club.id, true)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("viser kommende aktiviteter, men ikke dem, der er slut eller langt ude, og aflyste som aflyst", async () => {
    const mette = await ctxOf("mette");
    const soon = new Date(Date.now() + 3_600_000);
    await createEvent(db, mette, demo.teams.u9.id, { type: "training", title: "Aftentræning", startsAt: soon, endsAt: new Date(soon.getTime() + 3_600_000), location: "Bane 2" });
    await createEvent(db, mette, demo.teams.u9.id, { type: "match", title: "Kamp i næste måned", startsAt: new Date(Date.now() + 40 * DAY) });
    await createEvent(db, mette, demo.teams.u9.id, { type: "training", title: "Gammel træning", startsAt: new Date(Date.now() - 3 * DAY), endsAt: new Date(Date.now() - 3 * DAY + 3_600_000) });
    const cancelled = await createEvent(db, mette, demo.teams.u9.id, { type: "match", title: "Aflyst kamp", startsAt: new Date(Date.now() + 2 * DAY) });
    await setEventCancelled(db, mette, cancelled.id, true);
    const events = (await getPublicSite(db, "skovby-if"))!.days!.flatMap((d) => d.events);
    const titles = events.map((e) => e.title);
    expect(titles).toContain("Aftentræning");
    expect(titles).not.toContain("Kamp i næste måned");
    expect(titles).not.toContain("Gammel træning");
    expect(events.find((e) => e.title === "Aflyst kamp")?.cancelled).toBe(true);
  });

  it("kan skjule hold og kalender", async () => {
    await saveSiteSettings(db, await ctxOf("karen"), clubId, { ...base, showTeams: false, showCalendar: false });
    const site = (await getPublicSite(db, "skovby-if"))!;
    expect(site.teams).toBeNull();
    expect(site.days).toBeNull();
  });

  it("afslører aldrig personer eller børn", async () => {
    await saveSiteSettings(db, await ctxOf("karen"), clubId, base);
    const json = JSON.stringify(await getPublicSite(db, "skovby-if"));
    for (const secret of ["Niklas", "Emma", "Mette", "Sofie", "@holdliv.test", "Hassan"]) expect(json).not.toContain(secret);
  });

  it("slukker igen", async () => {
    await saveSiteSettings(db, await ctxOf("karen"), clubId, { ...base, enabled: false });
    expect(await getPublicSite(db, "skovby-if")).toBeNull();
  });
});
