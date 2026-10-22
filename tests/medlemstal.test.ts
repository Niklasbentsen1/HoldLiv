// Medlemstal pr. aldersgruppe og hold på en valgt dato.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { loadAccessContext } from "../src/auth/context";
import { registerUser, createClub, createTeam, memberStats, memberStatsCsv } from "../src/services";
import { clubMemberships, profiles, teamMembers } from "../src/db/schema";

const { db, sql, reset } = testDb();
const now = new Date("2026-11-02T12:00:00Z");
let clubId: string;
let teamId: string;
let admin: Awaited<ReturnType<typeof loadAccessContext>>;

async function add(first: string, birthDate: string | null, joined: string, left?: string, team = false) {
  const [p] = await db.insert(profiles).values({ firstName: first, lastName: "T", birthDate }).returning();
  await db.insert(clubMemberships).values({ clubId, profileId: p.id, joinedAt: new Date(`${joined}T10:00:00Z`), leftAt: left ? new Date(`${left}T10:00:00Z`) : null });
  if (team) await db.insert(teamMembers).values({ teamId, profileId: p.id, role: "player" });
  return p.id;
}

beforeAll(async () => {
  await reset();
  const a = await registerUser(db, "admin@mt.test", { firstName: "Ad", lastName: "Min", birthDate: "1970-01-01" });
  clubId = (await createClub(db, await loadAccessContext(db, a.user.id, now), "Tal IF", "tal-if")).id;
  admin = await loadAccessContext(db, a.user.id, now);
  teamId = (await createTeam(db, admin, clubId, "U12")).id;
  await db.update(clubMemberships).set({ joinedAt: new Date("2020-01-01T00:00:00Z") }).where(eq(clubMemberships.profileId, a.profile.id));
  await add("Lille", "2022-05-01", "2026-01-01");
  await add("Barn", "2016-06-01", "2025-01-01", undefined, true);
  await add("Teen", "2010-11-02", "2024-01-01", undefined, true);
  await add("Ung", "2004-01-01", "2024-01-01");
  await add("Gammel", "1950-01-01", "2020-01-01");
  await add("Udmeldt", "2015-01-01", "2024-01-01", "2026-03-01", true);
  await add("Ny", "2015-01-01", "2026-12-01");
  await add("Ukendt", null, "2024-01-01");
});
afterAll(async () => {
  await sql.end();
});

describe("medlemstal", () => {
  it("tæller aktive medlemmer pr. aldersgruppe på dagen", async () => {
    const s = await memberStats(db, admin, clubId, "2026-11-02");
    const count = (k: string) => s.bands.find((b) => b.key === k)!.count;
    expect([count("0-5"), count("6-12"), count("13-18"), count("19-24"), count("25-59"), count("60+")]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(s).toMatchObject({ total: 7, unknown: 1, under18: 3, under25: 4 });
    expect(s.perTeam).toEqual([expect.objectContaining({ name: "U12", players: 2 })]);
  });

  it("alderen regnes på den valgte dag, og udmeldte og ikke-indmeldte tæller ikke", async () => {
    // 1. februar: Udmeldt er stadig med, og Ny er ikke indmeldt endnu.
    const before = await memberStats(db, admin, clubId, "2026-02-01");
    expect(before.total).toBe(8);
    expect(before.perTeam[0].players).toBe(3);
    // 15. december: Ny er kommet til, Udmeldt er gået.
    const later = await memberStats(db, admin, clubId, "2026-12-15");
    expect(later.total).toBe(8);
    expect(later.perTeam[0].players).toBe(2);
    // Teen fylder 16 den 2. november, men er stadig 13-18; Barn (født 2016-06-01) er 10 og i 6-12.
    expect(later.bands.find((b) => b.key === "6-12")!.count).toBe(2);
  });

  it("kun admin/kasserer og gyldig dato, og regnearket har tallene", async () => {
    const u = await registerUser(db, "alm@mt.test", { firstName: "Al", lastName: "M", birthDate: "1990-01-01" });
    await expect(memberStats(db, await loadAccessContext(db, u.user.id, now), clubId, "2026-11-02")).rejects.toThrow();
    await expect(memberStats(db, admin, clubId, "i går")).rejects.toThrow("dato");
    const csv = await memberStatsCsv(db, admin, clubId, "2026-11-02");
    expect(csv).toContain("0–5 år;1");
    expect(csv).toContain("Uden fødselsdato;1");
    expect(csv).toContain("I alt;7");
    expect(csv).toContain("U12;;2");
  });
});
