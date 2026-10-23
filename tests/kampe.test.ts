// Kampe, opstilling, referat og statistik mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { mergeProfile } from "../src/auth/merge";
import { parseConfig, MODULES } from "../src/modules/registry";
import {
  addMatchEvent,
  clearResult,
  createEvent,
  exportMyData,
  getMatchSheet,
  getTeamStats,
  listMatches,
  recordResult,
  removeMatchEvent,
  saveLineup,
  saveReport,
  setLineupPublished,
  setTeamModule,
  unpublishReport,
  updateModuleConfig,
} from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
let u11: string;
let match1: string;
let match2: string;
const sent: { to: string; subject: string }[] = [];
const deliver = { mail: async (to: string, subject: string) => void sent.push({ to, subject }), sms: null, baseUrl: "https://x.test" };

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
  u11 = demo.teams.u11.id;
  const jonas = await ctxOf("jonas");
  await setTeamModule(db, await ctxOf("karen"), u11, "matches", true);
  const [m] = await sql`select id from events where team_id = ${u11} and type = 'match' order by starts_at limit 1`;
  match1 = m.id;
  const later = new Date(Date.now() + 14 * 86_400_000);
  match2 = (await createEvent(db, jonas, u11, { type: "match", title: "Kamp mod Vejen", startsAt: later, endsAt: new Date(later.getTime() + 3_600_000) })).id;
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = async (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const kid = (k: keyof typeof demo.kids) => demo.kids[k].id;
const afterKickoff = async (key: keyof typeof demo.users, eventId: string, hours = 3) => {
  const [e] = await sql`select starts_at from events where id = ${eventId}`;
  return { ...(await ctxOf(key)), now: new Date(new Date(e.starts_at).getTime() + hours * 3_600_000) };
};

describe("modulet", () => {
  it("kræver at modulet er slået til", async () => {
    await expect(getMatchSheet(db, await ctxOf("mette"), (await sql`select id from events where team_id = ${demo.teams.u9.id} and type = 'match' limit 1`)[0].id)).rejects.toThrow(/ikke slået til/);
  });

  it("har rangliste slået fra og 7 på banen som standard", () => {
    expect(parseConfig(MODULES.matches, {})).toEqual({ startersCount: 7, showRankings: false });
    expect(() => parseConfig(MODULES.matches, { startersCount: "2" })).toThrow();
  });

  it("er ikke åbent for fremmede", async () => {
    await expect(getMatchSheet(db, await ctxOf("ali"), match1)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("hører kun til kampe", async () => {
    const jonas = await ctxOf("jonas");
    const [t] = await sql`select id from events where team_id = ${u11} and type = 'training' limit 1`;
    await expect(saveLineup(db, jonas, t.id, { entries: [] })).rejects.toThrow(/kampe/);
  });
});

describe("opstilling", () => {
  it("laves kun af trænere, og kun med spillere fra holdet", async () => {
    const entries = [{ profileId: kid("lukas"), slot: "start" as const }];
    await expect(saveLineup(db, await ctxOf("sofie"), match1, { entries })).rejects.toThrow(/Kun trænere/);
    const jonas = await ctxOf("jonas");
    await expect(saveLineup(db, jonas, match1, { entries: [{ profileId: kid("emma"), slot: "start" }] })).rejects.toThrow(/spillere på holdet/);
    await expect(saveLineup(db, jonas, match1, { entries: [entries[0], entries[0]] })).rejects.toThrow(/én gang/);
  });

  it("holder sig til antal spillere på banen", async () => {
    const jonas = await ctxOf("jonas");
    await updateModuleConfig(db, jonas, u11, "matches", { startersCount: "3" });
    const four = (["lukas", "kasper", "oliver", "william"] as const).map((k) => ({ profileId: kid(k), slot: "start" as const }));
    await expect(saveLineup(db, jonas, match1, { entries: four })).rejects.toThrow(/3 spillere på banen/);
  });

  it("er en kladde, til den udgives, og sendes som besked", async () => {
    const jonas = await ctxOf("jonas");
    await expect(setLineupPublished(db, jonas, match1, true)).rejects.toThrow(/Vælg spillere/);
    await saveLineup(db, jonas, match1, {
      opponent: " Them B&I ",
      formation: "1-2",
      entries: [
        { profileId: kid("lukas"), slot: "start", position: "Forsvar" },
        { profileId: kid("kasper"), slot: "start", position: "Angreb" },
        { profileId: kid("oliver"), slot: "start" },
        { profileId: kid("william"), slot: "bench" },
      ],
    });
    const draftForCoach = await getMatchSheet(db, jonas, match1);
    expect(draftForCoach.opponent).toBe("Them B&I");
    expect(draftForCoach.lineup.map((l) => l.name.split(" ")[0])).toEqual(["Lukas", "Kasper", "Oliver", "William"]);
    expect(draftForCoach.squad).toHaveLength(4);
    // Forældre ser intet, før den er udgivet.
    const draftForParent = await getMatchSheet(db, await ctxOf("sofie"), match1);
    expect(draftForParent.lineup).toEqual([]);
    expect(draftForParent.formation).toBeNull();
    expect(draftForParent.squad).toEqual([]);

    await setLineupPublished(db, jonas, match1, true, deliver);
    expect(sent.some((s) => /Opstillingen er klar/.test(s.subject))).toBe(true);
    const n = sent.length;
    await setLineupPublished(db, jonas, match1, true, deliver);
    expect(sent.length).toBe(n);
    const forParent = await getMatchSheet(db, await ctxOf("sofie"), match1);
    expect(forParent.lineup).toHaveLength(4);
    expect(forParent.lineup.find((l) => l.name.startsWith("Lukas"))).toMatchObject({ slot: "start", position: "Forsvar", mine: true });
    expect(forParent.formation).toBe("1-2");

    await setLineupPublished(db, jonas, match1, false);
    expect((await getMatchSheet(db, await ctxOf("sofie"), match1)).lineup).toEqual([]);
    await setLineupPublished(db, jonas, match1, true);
  });
});

describe("resultat, mål og kort", () => {
  it("kan ikke indtastes før kampen er begyndt", async () => {
    await expect(recordResult(db, await ctxOf("jonas"), match1, { goalsFor: 1, goalsAgainst: 0 })).rejects.toThrow(/begyndt/);
  });

  it("indtastes af træneren med spilletid", async () => {
    const jonas = await afterKickoff("jonas", match1);
    await expect(recordResult(db, await afterKickoff("sofie", match1), match1, { goalsFor: 3, goalsAgainst: 1 })).rejects.toThrow(/Kun trænere/);
    await expect(recordResult(db, jonas, match1, { goalsFor: -1, goalsAgainst: 1 })).rejects.toThrow(/mål/);
    await expect(recordResult(db, jonas, match1, { goalsFor: 3, goalsAgainst: 1, minutes: { [kid("emma")]: 20 } })).rejects.toThrow(/i opstillingen/);
    await recordResult(db, jonas, match1, {
      goalsFor: 3,
      goalsAgainst: 1,
      minutes: { [kid("lukas")]: 40, [kid("kasper")]: 40, [kid("oliver")]: 25, [kid("william")]: 15 },
    });
  });

  it("noterer mål og kort for spillere i opstillingen og holder sig til resultatet", async () => {
    const jonas = await afterKickoff("jonas", match1);
    await expect(addMatchEvent(db, jonas, match1, { kind: "goal", profileId: kid("noor") })).rejects.toThrow(/ikke i opstillingen/);
    await expect(addMatchEvent(db, jonas, match1, { kind: "yellow" })).rejects.toThrow(/Vælg hvem/);
    await expect(addMatchEvent(db, jonas, match1, { kind: "goal", profileId: kid("kasper"), assistProfileId: kid("kasper") })).rejects.toThrow(/sig selv/);
    await expect(addMatchEvent(db, jonas, match1, { kind: "red", profileId: kid("kasper"), assistProfileId: kid("lukas") })).rejects.toThrow(/assist/);
    await addMatchEvent(db, jonas, match1, { kind: "goal", profileId: kid("kasper"), assistProfileId: kid("lukas"), minute: 5 });
    await addMatchEvent(db, jonas, match1, { kind: "goal", profileId: kid("kasper"), minute: 18 });
    const g3 = await addMatchEvent(db, jonas, match1, { kind: "goal", profileId: kid("oliver"), assistProfileId: kid("kasper"), minute: 30 });
    await expect(addMatchEvent(db, jonas, match1, { kind: "goal" })).rejects.toThrow(/allerede noteret/);
    await expect(recordResult(db, jonas, match1, { goalsFor: 2, goalsAgainst: 1 })).rejects.toThrow(/Fjern et mål/);
    await removeMatchEvent(db, jonas, g3.id);
    await addMatchEvent(db, jonas, match1, { kind: "goal", minute: 33 });
    await addMatchEvent(db, jonas, match1, { kind: "yellow", profileId: kid("william"), minute: 22 });
  });

  it("mål ses af alle på holdet, kort kun af trænere og spillerens egen familie", async () => {
    const forLars = await getMatchSheet(db, await afterKickoff("lars", match1), match1);
    expect(forLars.goalsFor).toBe(3);
    expect(forLars.events.map((e) => e.kind)).toEqual(["goal", "goal", "goal"]);
    expect(forLars.events[0]).toMatchObject({ playerName: expect.stringContaining("Kasper"), assistName: expect.stringContaining("Lukas") });
    expect(forLars.events[2].playerName).toBeNull();
    const forMette = await getMatchSheet(db, await afterKickoff("mette", match1), match1);
    expect(forMette.events.filter((e) => e.kind === "yellow")).toHaveLength(1);
    expect((await getMatchSheet(db, await afterKickoff("jonas", match1), match1)).events).toHaveLength(4);
  });

  it("kan rettes og fjernes", async () => {
    const jonas = await afterKickoff("jonas", match1);
    await clearResult(db, jonas, match1);
    expect((await getTeamStats(db, jonas, u11)).record.played).toBe(0);
    expect((await getMatchSheet(db, await afterKickoff("sofie", match1), match1)).goalsFor).toBeNull();
    await recordResult(db, jonas, match1, { goalsFor: 3, goalsAgainst: 1 });
    expect((await getTeamStats(db, jonas, u11)).record.played).toBe(1);
  });

  it("kan ikke noteres på en aflyst kamp", async () => {
    await sql`update events set cancelled_at = now() where id = ${match2}`;
    await expect(saveLineup(db, await ctxOf("jonas"), match2, { entries: [] })).rejects.toThrow(/aflyst/);
    await sql`update events set cancelled_at = null where id = ${match2}`;
  });
});

describe("referat", () => {
  it("er en kladde, til træneren udgiver det", async () => {
    const jonas = await ctxOf("jonas");
    await expect(saveReport(db, await ctxOf("sofie"), match1, { text: "x" })).rejects.toThrow(/Kun trænere/);
    await expect(saveReport(db, jonas, match1, { text: " ", publish: true })).rejects.toThrow(/Skriv/);
    await expect(saveReport(db, jonas, match1, { text: "x".repeat(8001) })).rejects.toThrow(/8000/);
    await saveReport(db, jonas, match1, { text: "Flot kamp af alle." });
    expect((await getMatchSheet(db, jonas, match1)).report).toBe("Flot kamp af alle.");
    expect((await getMatchSheet(db, await ctxOf("sofie"), match1)).report).toBeNull();
    expect((await listMatches(db, jonas, u11)).past[0]).toMatchObject({ draft: true, hasReport: false });
    await saveReport(db, jonas, match1, { text: "Flot kamp af alle.", publish: true });
    const seen = await getMatchSheet(db, await ctxOf("sofie"), match1);
    expect(seen.report).toBe("Flot kamp af alle.");
    expect(seen.reportPublished).toBe(true);
    await unpublishReport(db, jonas, match1);
    expect((await getMatchSheet(db, await ctxOf("sofie"), match1)).report).toBeNull();
    await saveReport(db, jonas, match1, { text: "Flot kamp af alle.", publish: true });
  });
});

describe("statistik", () => {
  it("giver sæsonen og tal pr. spiller til trænerne", async () => {
    // En kamp mere: tabt 0-2, Lukas og Kasper starter, William kommer ind.
    const jonas = await ctxOf("jonas");
    await saveLineup(db, jonas, match2, {
      opponent: "Vejen",
      entries: [
        { profileId: kid("lukas"), slot: "start" },
        { profileId: kid("kasper"), slot: "start" },
        { profileId: kid("william"), slot: "bench" },
        { profileId: kid("oliver"), slot: "bench" },
      ],
    });
    const after = await afterKickoff("jonas", match2);
    await recordResult(db, after, match2, { goalsFor: 0, goalsAgainst: 2, minutes: { [kid("lukas")]: 45, [kid("kasper")]: 45, [kid("william")]: 10, [kid("oliver")]: 0 } });
    await addMatchEvent(db, after, match2, { kind: "red", profileId: kid("kasper"), minute: 40 });

    const stats = await getTeamStats(db, jonas, u11);
    expect(stats.record).toEqual({ played: 2, wins: 1, draws: 0, losses: 1, goalsFor: 3, goalsAgainst: 3 });
    expect(stats.results.map((r) => r.opponent)).toEqual(["Vejen", "Them B&I"]);
    const by = Object.fromEntries(stats.players.map((p) => [p.name.split(" ")[0], p]));
    expect(by.Kasper).toMatchObject({ matches: 2, starts: 2, minutes: 85, goals: 2, assists: 0, yellow: 0, red: 1 });
    expect(by.Lukas).toMatchObject({ matches: 2, starts: 2, minutes: 85, goals: 0, assists: 1 });
    // Oliver sad på bænken uden spilletid i anden kamp.
    expect(by.Oliver).toMatchObject({ matches: 1, starts: 1, minutes: 25 });
    expect(by.William).toMatchObject({ matches: 2, starts: 0, minutes: 25, yellow: 1 });
    expect(stats.players[0].name).toMatch(/^Kasper/);
  });

  it("viser forældre kun egne børns tal, med mindre holdet slår rangliste til", async () => {
    const sofie = await ctxOf("sofie");
    const own = await getTeamStats(db, sofie, u11);
    expect(own.rankingsShown).toBe(false);
    expect(own.players.map((p) => p.name.split(" ")[0])).toEqual(["Lukas"]);
    expect(own.record.played).toBe(2);
    await updateModuleConfig(db, await ctxOf("jonas"), u11, "matches", { startersCount: "3", showRankings: "on" });
    expect((await getTeamStats(db, sofie, u11)).players).toHaveLength(4);
    await updateModuleConfig(db, await ctxOf("jonas"), u11, "matches", { startersCount: "3" });
    expect((await getTeamStats(db, sofie, u11)).players).toHaveLength(1);
  });

  it("kampoversigten viser kommende og spillede kampe", async () => {
    const list = await listMatches(db, await ctxOf("sofie"), u11);
    expect(list.canManage).toBe(false);
    expect(list.past.map((m) => m.title)).toEqual(expect.arrayContaining(["Kamp mod Them B&I", "Kamp mod Vejen"]));
    expect(list.past.find((m) => m.title === "Kamp mod Them B&I")).toMatchObject({ played: true, goalsFor: 3, goalsAgainst: 1, hasReport: true });
  });
});

describe("persondata", () => {
  it("kommer med i dataudtræk, og en sammenfletning afbrydes frem for at miste tal", async () => {
    const dump = JSON.stringify(await exportMyData(db, await ctxOf("mette")));
    expect(dump).toContain("Kamp mod Them B&I");
    expect(await mergeProfile(db, kid("emma"), kid("william"))).toBe(false);
  });

  it("slettes med profilen: opstilling og kort væk, målet bliver stående uden navn", async () => {
    // Oliver (Henriks barn) har opstilling i begge kampe. Giv ham et gult kort og lad ham score og assistere.
    await sql`insert into match_events (event_id, kind, profile_id, minute) values (${match1}, 'yellow', ${kid("oliver")}, 12)`;
    await sql`update match_events set profile_id = ${kid("oliver")} where id = (select id from match_events where event_id = ${match1} and kind = 'goal' and profile_id is null limit 1)`;
    await sql`update match_events set assist_profile_id = ${kid("oliver")} where id = (select id from match_events where event_id = ${match1} and kind = 'goal' and profile_id = ${kid("kasper")} limit 1)`;
    await sql`update charges set status = 'paid' where status = 'open'`;
    const { deleteMyAccount } = await import("../src/services");
    await deleteMyAccount(db, await ctxOf("henrik"), demo.users.henrik.user.email);
    expect((await sql`select count(*)::int as n from match_players where profile_id = ${kid("oliver")}`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from match_events where kind = 'yellow' and event_id = ${match1} and minute = 12`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from match_events where kind = 'goal' and event_id = ${match1}`)[0].n).toBe(3);
    expect((await sql`select count(*)::int as n from match_events where profile_id = ${kid("oliver")} or assist_profile_id = ${kid("oliver")}`)[0].n).toBe(0);
    // Statistikken kan stadig udregnes, og målet står i resultatet.
    expect((await getTeamStats(db, await ctxOf("jonas"), u11)).record.goalsFor).toBe(3);
  });
});
