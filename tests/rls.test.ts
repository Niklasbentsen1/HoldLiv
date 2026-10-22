// Row-level security: en forening kan ikke se en anden forenings rækker, selv med en forespørgsel uden WHERE.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as dsql } from "drizzle-orm";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { withUserScope } from "../src/db/scope";
import { auditLog, charges, clubMemberships, clubs, events, posts, profiles, teams } from "../src/db/schema";
import { createClub, createTeam, createEvent, registerUser, createPost, logAudit, listFeed } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
let other: { clubId: string; userId: string; teamId: string };

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
  const u = await registerUser(db, "bestyrelse@anden.test", { firstName: "Bo", lastName: "Anden" });
  const club = await createClub(db, await loadAccessContext(db, u.user.id), "Anden IF", "anden-if");
  const ctx = await loadAccessContext(db, u.user.id);
  const team = await createTeam(db, ctx, club.id, "Hos andre");
  await createEvent(db, ctx, team.id, { title: "Hemmelig træning", startsAt: new Date("2030-01-01T10:00:00Z"), type: "training" } as never);
  await logAudit(db, { action: "club.member_added", clubId: club.id, actorUserId: u.user.id });
  other = { clubId: club.id, userId: u.user.id, teamId: team.id };
});
afterAll(async () => {
  await sql.end();
});

describe("row-level security", () => {
  it("ser kun egne foreninger, også uden WHERE", async () => {
    const sofie = demo.users.sofie.user.id;
    await withUserScope(db, sofie, async (tx) => {
      expect((await tx.select().from(clubs)).map((c) => c.id)).toEqual([demo.club.id]);
      expect((await tx.select().from(teams)).every((t) => t.clubId === demo.club.id)).toBe(true);
      expect((await tx.select().from(events)).every((e) => e.clubId === demo.club.id)).toBe(true);
      expect((await tx.select().from(clubMemberships)).every((m) => m.clubId === demo.club.id)).toBe(true);
      expect((await tx.select().from(charges)).every((c) => c.clubId === demo.club.id)).toBe(true);
    });
    await withUserScope(db, other.userId, async (tx) => {
      expect((await tx.select().from(clubs)).map((c) => c.id)).toEqual([other.clubId]);
      expect(await tx.select().from(teams)).toHaveLength(1);
      expect((await tx.select().from(events)).map((e) => e.title)).toEqual(["Hemmelig træning"]);
    });
  });

  it("uden bruger ses ingenting, og et ukendt login ser ingenting", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(dsql.raw("SET LOCAL ROLE holdliv_app"));
      expect(await tx.select().from(clubs)).toEqual([]);
      expect(await tx.select().from(profiles).limit(1)).toHaveLength(1); // personer er ikke foreningsbundne
    });
    await withUserScope(db, "00000000-0000-0000-0000-000000000000", async (tx) => {
      expect(await tx.select().from(clubs)).toEqual([]);
    });
  });

  it("kan ikke skrive i en fremmed forening", async () => {
    const sofie = await loadAccessContext(db, demo.users.sofie.user.id);
    await expect(
      withUserScope(db, sofie.userId, (tx) =>
        tx.insert(posts).values({ clubId: other.clubId, kind: "board", title: "x", body: "x", authorUserId: sofie.userId, authorProfileId: sofie.profileId }),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
    // Opdatering og sletning rammer ingen rækker.
    await withUserScope(db, sofie.userId, async (tx) => {
      expect(await tx.update(teams).set({ name: "Hacket" }).where(dsql`id = ${other.teamId}`).returning()).toEqual([]);
      expect(await tx.delete(events).where(dsql`team_id = ${other.teamId}`).returning()).toEqual([]);
    });
    expect((await db.select().from(teams).where(dsql`id = ${other.teamId}`))[0].name).toBe("Hos andre");
  });

  it("en forælder ser barnets forening", async () => {
    // Freja har to værger; Anne er værge og medlem via barnet.
    await withUserScope(db, demo.users.anne.user.id, async (tx) => {
      expect((await tx.select().from(clubs)).map((c) => c.id)).toEqual([demo.club.id]);
    });
  });

  it("tjenesterne virker uændret inde i et scope", async () => {
    const sofie = await loadAccessContext(db, demo.users.sofie.user.id);
    await withUserScope(db, sofie.userId, async (tx) => {
      const feed = await listFeed(tx as never, sofie, "news");
      expect(Array.isArray(feed)).toBe(true);
    });
  });

  it("revisionsloggen kan ikke ændres eller slettes af appen", async () => {
    await withUserScope(db, demo.users.karen.user.id, async (tx) => {
      await logAudit(tx as never, { action: "club.member_added", clubId: demo.club.id, actorUserId: demo.users.karen.user.id });
      expect((await tx.select().from(auditLog)).every((r) => r.clubId === demo.club.id)).toBe(true);
    });
    await expect(withUserScope(db, demo.users.karen.user.id, (tx) => tx.delete(auditLog))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
    await expect(withUserScope(db, demo.users.karen.user.id, (tx) => tx.update(auditLog).set({ action: "x" }))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
  });
});
