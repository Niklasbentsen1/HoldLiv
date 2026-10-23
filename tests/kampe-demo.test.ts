// Demoklubbens kampdata (db:seed) skal kunne oprettes og give tal i statistikken.
import { afterAll, beforeAll, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo, seedMatchDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { getMatchSheet, getTeamStats } from "../src/services";

const { db, sql, reset } = testDb();
beforeAll(reset);
afterAll(async () => {
  await sql.end();
});

it("seedMatchDemo giver en spillet U9-kamp med referat og en kommende med opstilling", async () => {
  const demo = await seedDemo(db);
  await seedMatchDemo(db, demo);
  const stats = await getTeamStats(db, await loadAccessContext(db, demo.users.mette.user.id), demo.teams.u9.id);
  expect(stats.record).toMatchObject({ played: 1, wins: 1, goalsFor: 4, goalsAgainst: 2 });
  expect(stats.players[0]).toMatchObject({ goals: 2 });
  const upcoming = await getMatchSheet(db, await loadAccessContext(db, demo.users.mette.user.id), demo.events.u9Match.id);
  expect(upcoming.lineup).toHaveLength(5);
  const parent = await getMatchSheet(db, await loadAccessContext(db, demo.users.niklas.user.id), demo.events.u9PastMatch.id);
  expect(parent.report).toMatch(/Flot sejr/);
});
