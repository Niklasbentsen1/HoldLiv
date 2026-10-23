// Infoskærmen mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { createEvent, createPost, createScreen, deleteScreen, getScreenView, listScreens, resetScreenToken, updateScreen, setEventCancelled, MAX_SCREENS, type Deliver } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
let clubId: string;
let token: string;

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

describe("infoskærm", () => {
  it("lader kun admin styre skærme", async () => {
    await expect(createScreen(db, await ctxOf("mette"), clubId, { name: "Hal" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createScreen(db, await ctxOf("sofie"), clubId, { name: "Hal" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listScreens(db, await ctxOf("ali"), clubId)).rejects.toBeInstanceOf(ForbiddenError);
    const karen = await ctxOf("karen");
    await expect(createScreen(db, karen, clubId, { name: " " })).rejects.toThrow(/navn/);
    await expect(createScreen(db, karen, clubId, { name: "A", daysAhead: 15 })).rejects.toThrow(/dage frem/);
    await expect(createScreen(db, karen, clubId, { name: "A", message: "x".repeat(301) })).rejects.toThrow(/300 tegn/);
    const s = await createScreen(db, karen, clubId, { name: "Klubhuset", message: "Husk skoene" });
    token = s.token;
    expect(token.length).toBeGreaterThanOrEqual(30);
  });

  it("viser kommende aktiviteter uden at kræve login, og aldrig personer", async () => {
    const mette = await ctxOf("mette");
    const soon = new Date(Date.now() + 3_600_000);
    await createEvent(db, mette, demo.teams.u9.id, { type: "training", title: "Aftentræning", startsAt: soon, endsAt: new Date(soon.getTime() + 3_600_000), location: "Bane 2" });
    const far = await createEvent(db, mette, demo.teams.u9.id, { type: "match", title: "Kamp langt ude", startsAt: new Date(Date.now() + 10 * DAY) });
    const view = (await getScreenView(db, token))!;
    expect(view.clubName).toBe("Skovby IF");
    expect(view.message).toBe("Husk skoene");
    const titles = view.days.flatMap((d) => d.events.map((e) => e.title));
    expect(titles).toContain("Aftentræning");
    expect(titles).not.toContain("Kamp langt ude");
    expect(far.id).toBeTruthy();
    const json = JSON.stringify(view);
    for (const secret of ["Niklas", "Emma", "Mette", "@holdliv.test", "Hassan"]) expect(json).not.toContain(secret);
  });

  it("viser aflyste aktiviteter som aflyst, og skjuler aktiviteter, der er slut", async () => {
    const mette = await ctxOf("mette");
    const soon = new Date(Date.now() + 2 * 3_600_000);
    const ev = await createEvent(db, mette, demo.teams.u9.id, { type: "training", title: "Aflyst træning", startsAt: soon });
    await setEventCancelled(db, mette, ev.id, true);
    const past = await sql`insert into events (club_id, team_id, type, title, starts_at, ends_at) values (${clubId}, ${demo.teams.u9.id}, 'training', 'Gammel træning', now() - interval '5 hours', now() - interval '4 hours') returning id`;
    expect(past).toHaveLength(1);
    const view = (await getScreenView(db, token))!;
    const events = view.days.flatMap((d) => d.events);
    expect(events.find((e) => e.title === "Aflyst træning")?.cancelled).toBe(true);
    expect(events.map((e) => e.title)).not.toContain("Gammel træning");
  });

  it("viser kun foreningens nyheder, ikke holdnyheder, og kan slå nyheder fra", async () => {
    const karen = await ctxOf("karen");
    await createPost(db, karen, deliver, { kind: "news", scope: `club:${clubId}`, title: "Generalforsamling", body: "Kom og vær med" });
    await createPost(db, await ctxOf("mette"), deliver, { kind: "news", scope: `team:${demo.teams.u9.id}`, title: "Kun for U9", body: "Hemmeligt for holdet" });
    const expired = await createPost(db, karen, deliver, { kind: "news", scope: `club:${clubId}`, title: "Gammel nyhed", body: "Udløbet" });
    await sql`update posts set expires_at = now() - interval '1 hour' where id = ${expired.id}`;
    let view = (await getScreenView(db, token))!;
    expect(view.news.map((n) => n.title)).toEqual(["Generalforsamling"]);
    const [screen] = await listScreens(db, karen, clubId);
    await updateScreen(db, karen, screen.id, { name: "Klubhuset", showNews: false, daysAhead: 7 });
    view = (await getScreenView(db, token))!;
    expect(view.news).toEqual([]);
  });

  it("afviser ukendte og ugyldige links, og et nulstillet link holder op med at virke", async () => {
    expect(await getScreenView(db, "findes-ikke-findes-ikke-findes")).toBeNull();
    expect(await getScreenView(db, "kort")).toBeNull();
    expect(await getScreenView(db, "x".repeat(100))).toBeNull();
    const karen = await ctxOf("karen");
    const [screen] = await listScreens(db, karen, clubId);
    await resetScreenToken(db, await ctxOf("niklas"), screen.id);
    expect(await getScreenView(db, token)).toBeNull();
    const [after] = await listScreens(db, karen, clubId);
    expect(after.token).not.toBe(token);
    expect(await getScreenView(db, after.token)).not.toBeNull();
    await deleteScreen(db, karen, screen.id);
    expect(await getScreenView(db, after.token)).toBeNull();
  });

  it("begrænser antallet af skærme", async () => {
    const karen = await ctxOf("karen");
    await Promise.all(Array.from({ length: MAX_SCREENS }, (_, i) => createScreen(db, karen, clubId, { name: `Skærm ${i}` }).catch(() => null)));
    expect(await listScreens(db, karen, clubId)).toHaveLength(MAX_SCREENS);
    await expect(createScreen(db, karen, clubId, { name: "For meget" })).rejects.toThrow(/højst/);
  });
});
