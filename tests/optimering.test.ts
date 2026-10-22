// Holdoptimering: regelbaserede forslag ud fra kapacitet, ventelister, trænere og tider, og AI-rådgiveren bag en grænseflade.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { loadAccessContext } from "../src/auth/context";
import { registerUser, createClub, createTeam, analyseClub, adviseClub, anonymiseTeams, groupByAge, MIN_NEW_TEAM } from "../src/services";
import { clubMemberships, events, profiles, teamMembers, teamWaitlist, teams } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { mockAdvisor, type AdvisorInput } from "../src/lib/advisor";

const { db, sql, reset } = testDb();
let clubId: string;
let admin: Awaited<ReturnType<typeof loadAccessContext>>;
const now = new Date("2026-11-02T12:00:00Z");
const T: Record<string, string> = {};
let n = 0;

async function person(birthYear: number) {
  const [p] = await db.insert(profiles).values({ firstName: `Barn${++n}`, lastName: "Test", birthDate: `${birthYear}-06-01` }).returning();
  await db.insert(clubMemberships).values({ clubId, profileId: p.id }).onConflictDoNothing();
  return p.id;
}
async function team(name: string, capacity: number | null) {
  const t = await createTeam(db, admin, clubId, name, "2026/27");
  await db.update(teams).set({ capacity }).where(eq(teams.id, t.id));
  T[name] = t.id;
  return t.id;
}
async function players(teamId: string, count: number, year: number) {
  for (let i = 0; i < count; i++) await db.insert(teamMembers).values({ teamId, profileId: await person(year), role: "player" });
}
async function coaches(teamId: string, count: number) {
  for (let i = 0; i < count; i++) await db.insert(teamMembers).values({ teamId, profileId: await person(1985), role: "coach" });
}
async function waiting(teamId: string, count: number, year: number) {
  for (let i = 0; i < count; i++) await db.insert(teamWaitlist).values({ teamId, profileId: await person(year) });
}

beforeAll(async () => {
  await reset();
  const u = await registerUser(db, "formand@opt.test", { firstName: "Fa", lastName: "Mand", birthDate: "1970-01-01" });
  clubId = (await createClub(db, await loadAccessContext(db, u.user.id, now), "Opt IF", "opt-if")).id;
  admin = await loadAccessContext(db, u.user.id, now);

  const a = await team("A U9", 12);
  await players(a, 12, 2017); // 9 år
  await coaches(a, 1);
  await waiting(a, 4, 2017);
  const b = await team("B U11", 12);
  await players(b, 12, 2015);
  await coaches(b, 1);
  await waiting(b, 3, 2016); // sammen med A's ventende: 7 børn på 9-10 år
  const c = await team("C U13", null);
  await players(c, 5, 2013);
  const d = await team("D U15", 10);
  await players(d, 10, 2011);
  await coaches(d, 2);
  await waiting(d, 2, 2011);
  const e = await team("E U17", 28);
  await players(e, 28, 2009);
  await coaches(e, 1);
  await waiting(e, 3, 2009);
  // A træner tirsdag 17-18 på Bane 3 (11. nov. 2026 = onsdag, så brug 3. nov = tirsdag).
  for (const day of [3, 10, 17]) {
    await db.insert(events).values({ clubId, teamId: a, type: "training", title: "Træning", location: "Bane 3", startsAt: new Date(Date.UTC(2026, 10, 1 + day - 1, 16, 0)) });
  }
});
afterAll(async () => {
  await sql.end();
});

describe("holdforslag", () => {
  it("grupperer ventende i aldersgrupper på højst to år", () => {
    expect(groupByAge([{ age: 9, teamId: "a" }, { age: 10, teamId: "b" }, { age: 11, teamId: "a" }, { age: 12, teamId: "b" }, { age: 15, teamId: "c" }]).map((g) => g.ages)).toEqual([[9, 10, 11], [12], [15]].map((x) => x));
  });

  it("foreslår et nyt hold, når nok i samme alder venter på tværs af hold", async () => {
    const { suggestions } = await analyseClub(db, admin, clubId);
    const ny = suggestions.find((s) => s.kind === "ny_hold")!;
    expect(ny.severity).toBe("high");
    expect(ny.title).toBe("Opret et nyt hold for 9-10 år");
    expect(ny.detail).toContain("7 børn venter på A U9, B U11");
    expect(7).toBeGreaterThanOrEqual(MIN_NEW_TEAM);
    expect(ny.teamIds.sort()).toEqual([T["A U9"], T["B U11"]].sort());
  });

  it("foreslår flere pladser, når trænerne kan klare det, og flere trænere, når de ikke kan", async () => {
    const { suggestions } = await analyseClub(db, admin, clubId);
    expect(suggestions.find((s) => s.kind === "hæv_kapacitet")?.title).toBe("Hæv D U15 fra 10 til 12 pladser");
    const mangler = suggestions.filter((s) => s.kind === "mangler_traener");
    expect(mangler.some((s) => s.title.startsWith("C U13 mangler en træner") && s.severity === "high")).toBe(true);
    expect(mangler.some((s) => s.title.startsWith("E U17 skal bruge 2 ekstra trænere") && s.severity === "medium")).toBe(true);
    // Hold dækket af et nyt hold får ikke også et forslag om flere pladser.
    expect(suggestions.some((s) => s.kind === "hæv_kapacitet" && s.teamIds.includes(T["A U9"]))).toBe(false);
  });

  it("peger på ledige tider på de baner, holdene allerede bruger", async () => {
    const { suggestions } = await analyseClub(db, admin, clubId);
    const tid = suggestions.find((s) => s.kind === "ledig_tid")!;
    expect(tid.title).toContain("Bane 3");
    expect(tid.title).toContain("mandag kl. 16-19");
    expect(tid.title).not.toContain("tirsdag"); // optaget
  });

  it("sorterer det vigtigste først og kræver admin", async () => {
    const { suggestions } = await analyseClub(db, admin, clubId);
    const order = suggestions.map((s) => s.severity);
    expect(order).toEqual([...order].sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a] - ({ high: 0, medium: 1, low: 2 })[b]));
    const other = await registerUser(db, "fremmed@opt.test", { firstName: "Fre", lastName: "Mmed" });
    await expect(analyseClub(db, await loadAccessContext(db, other.user.id, now), clubId)).rejects.toThrow();
  });
});

describe("anonymisering af holdnavne", () => {
  const names = ["A", ...Array.from({ length: 10 }, (_, i) => `U${i + 9} piger`), "A-team"];
  it("sætter navnene tilbage, også med 10 hold eller flere", () => {
    const anon = anonymiseTeams(names);
    const text = "Hold 1 og Hold 10 og Hold 12 er presset. Hold 13 findes ikke.";
    expect(anon.back(text)).toBe("A og U17 piger og A-team er presset. Hold 13 findes ikke.");
  });
  it("erstatter kun hele navne, så et kort navn ikke rammer andre ord", () => {
    const anon = anonymiseTeams(names);
    expect(anon.out("Hæv A fra 10 til 12. A-team mangler en træner, og Aften er et ord. U9 piger venter.")).toBe(
      "Hæv Hold 1 fra 10 til 12. Hold 12 mangler en træner, og Aften er et ord. Hold 2 venter.",
    );
  });
});

describe("AI-rådgiver", () => {
  it("får kun sammentalte tal, aldrig personer, og kan udskiftes", async () => {
    let seen: AdvisorInput | null = null;
    const text = await adviseClub(db, admin, clubId, async (input) => {
      seen = input;
      return mockAdvisor(input);
    });
    expect(text).toContain("Opt IF har 5 hold");
    const sent = JSON.stringify(seen);
    expect(sent).not.toMatch(/Barn\d|Test|formand@|A U9|B U11/);
    expect(JSON.stringify(seen!.suggestions)).toMatch(/Hold \d/);
    expect(seen!.teams[0]).toEqual({ name: "Hold 1", capacity: 12, players: 12, waiting: 4, coaches: 1, ageMin: 9, ageMax: 9 });
    const log = await sql`select action from audit_log where action = 'ai.advice'`;
    expect(log).toHaveLength(1);
  });
});
