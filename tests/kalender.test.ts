// Kalenderabonnement og iCalendar-opbygning.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { buildFeed, createEvent, getFeedToken, resetFeedToken, setEventCancelled } from "../src/services";
import { buildCalendar, foldLine, icsDate, icsEscape } from "../src/lib/ics";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
});
afterAll(async () => {
  await sql.end();
});
const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const BASE = "https://holdliv.test";

describe("iCalendar", () => {
  it("formaterer tid i UTC og escaper tekst", () => {
    expect(icsDate(new Date("2026-10-22T14:30:05Z"))).toBe("20261022T143005Z");
    expect(icsEscape("Bane 1, ude; ring\nTak")).toBe("Bane 1\\, ude\\; ring\\nTak");
  });

  it("folder lange linjer uden at skille tegn ad og bevarer indholdet", () => {
    const long = `SUMMARY:${"æøå".repeat(40)}`;
    const folded = foldLine(long);
    for (const l of folded.split("\r\n")) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("bygger en gyldig kalender med aflyste aktiviteter", () => {
    const t = new Date("2026-11-01T17:00:00Z");
    const ics = buildCalendar("Test", [{ uid: "a@holdliv", start: t, end: t, stamp: t, summary: "U9: Kamp", cancelled: true }]);
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics).toContain("SUMMARY:AFLYST: U9: Kamp");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    const withPlace = buildCalendar("T", [{ uid: "b@holdliv", start: t, end: t, stamp: t, summary: "x", location: "Hal 2; indgang B, bag skolen" }]);
    expect(withPlace).toContain("LOCATION:Hal 2\\; indgang B\\, bag skolen");
  });
});

describe("abonnement", () => {
  it("giver samme hemmelige link hver gang, og et nyt efter nulstilling", async () => {
    const ctx = await ctxOf("niklas");
    const a = await getFeedToken(db, ctx);
    expect(await getFeedToken(db, ctx)).toBe(a);
    expect(a.length).toBeGreaterThanOrEqual(30);
    const b = await resetFeedToken(db, ctx);
    expect(b).not.toBe(a);
    expect(await buildFeed(db, a, BASE)).toBeNull();
    expect(await buildFeed(db, b, BASE)).not.toBeNull();
    expect(await buildFeed(db, "gaet", BASE)).toBeNull();
  });

  it("viser mine børns hold med børnenes navn, og kun dem", async () => {
    const token = await getFeedToken(db, await ctxOf("niklas")); // far til Emma (U9) og selv senior-spiller
    const ics = (await buildFeed(db, token, BASE))!;
    expect(ics).toContain("SUMMARY:U9 piger: Træning (Emma)");
    expect(ics).toContain(`URL:${BASE}/aktivitet/${demo.events.u9Training.id}`);
    expect(ics).toContain("U9 piger: Kamp mod Bryrup IF (Emma)");
    expect(ics).toContain("(dig)"); // seniorholdet, hvor han selv spiller
    expect(ics).not.toContain("U11");
    expect(ics).toContain("LOCATION:Bryrup Stadion");
  });

  it("viser trænerens hold uden navne, og aflysninger markeres", async () => {
    const mette = await ctxOf("mette");
    const token = await getFeedToken(db, mette);
    await setEventCancelled(db, mette, demo.events.u9Match.id, true);
    const ics = (await buildFeed(db, token, BASE))!;
    expect(ics).toContain("SUMMARY:AFLYST: U9 piger: Kamp mod Bryrup IF");
    expect(ics).toContain("STATUS:CANCELLED");
    await setEventCancelled(db, mette, demo.events.u9Match.id, false);
  });

  it("nye aktivitetstyper kommer med, og andre hold gør ikke", async () => {
    const ali = await ctxOf("ali");
    const token = await getFeedToken(db, ali);
    const mette = await ctxOf("mette");
    await createEvent(db, mette, demo.teams.u9.id, { type: "tournament", title: "Turnering i Horsens", startsAt: new Date(Date.now() + 5 * 86_400_000) });
    await createEvent(db, mette, demo.teams.u9.id, { type: "social", title: "Pizzaaften", startsAt: new Date(Date.now() + 6 * 86_400_000) });
    const ics = (await buildFeed(db, token, BASE))!;
    expect(ics).toContain("SUMMARY:U9 piger: Stævne: Turnering i Horsens (Noor)");
    expect(ics).toContain("U9 piger: Socialt: Pizzaaften (Noor)");
    expect(ics).not.toContain("U11");
  });
});
