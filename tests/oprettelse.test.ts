// Kører mod en rigtig Postgres (TEST_DATABASE_URL).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { clubRoles } from "../src/db/schema";
import { loadAccessContext } from "../src/auth/context";
import { checkSlug, createTeam, grantClubAdmin, MAX_CLUBS_PER_CREATOR, MAX_CLUBS_PER_DAY, onboardingSteps, registerClub, revokeClubAdmin, slugify } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
});
afterAll(() => sql.end());

describe("oprettelse af forening", () => {
  it("laver adresse af navn", () => {
    expect(slugify("Skovby Idrætsforening!")).toBe("skovby-idraetsforening");
    expect(slugify("Ålborg  Ø-klub")).toBe("aalborg-oe-klub");
    expect(checkSlug("ab")).toBeTruthy();
    expect(checkSlug("login")).toBeTruthy();
    expect(checkSlug("fin-klub")).toBeNull();
  });

  it("gør den der opretter til første admin, og afviser optaget adresse", async () => {
    const mette = demo.users.mette.user.id;
    const ctx = await loadAccessContext(db, mette);
    const club = await registerClub(db, ctx, { name: "  Nyby   Håndbold ", slug: null });
    expect(club.slug).toBe("nyby-haandbold");
    expect(club.name).toBe("Nyby Håndbold");
    const roles = await db.select().from(clubRoles).where(eq(clubRoles.clubId, club.id));
    expect(roles.map((r) => r.role)).toEqual(["admin"]);
    await expect(registerClub(db, await loadAccessContext(db, mette), { name: "Anden", slug: "nyby-haandbold" })).rejects.toThrow(/optaget/);
    await expect(registerClub(db, ctx, { name: "", slug: null })).rejects.toThrow();
  });

  it("samtidige oprettelser rammer døgngrænsen", async () => {
    const u = demo.users.ali.user.id;
    const results = await Promise.allSettled(Array.from({ length: 10 }, async (_, i) => registerClub(db, await loadAccessContext(db, u), { name: `Spam ${i}`, slug: null })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(MAX_CLUBS_PER_DAY);
  });

  it("grænsen i alt kan ikke omgås ved at give admin videre", async () => {
    const u = demo.users.anne.user.id;
    const other = demo.users.sofie.profile.id;
    for (let i = 0; i < MAX_CLUBS_PER_CREATOR; i++) {
      await sql`update audit_log set created_at = now() - interval '2 days' where action = 'club.registered' and actor_user_id = ${u}`;
      const ctx = await loadAccessContext(db, u);
      const club = await registerClub(db, ctx, { name: `Anne ${i}`, slug: null });
      // Giv admin til en anden og fjern sig selv: adminClubs bliver tom igen.
      await grantClubAdmin(db, await loadAccessContext(db, u), club.id, other);
      await revokeClubAdmin(db, await loadAccessContext(db, demo.users.sofie.user.id), club.id, (await loadAccessContext(db, u)).profileId);
    }
    await sql`update audit_log set created_at = now() - interval '2 days' where action = 'club.registered' and actor_user_id = ${u}`;
    const ctx = await loadAccessContext(db, u);
    expect(ctx.adminClubs.size).toBe(0);
    await expect(registerClub(db, ctx, { name: "Anne for meget", slug: null })).rejects.toThrow(/højst/);
  });

  it("guiden viser fremdrift og kun for admin", async () => {
    const ctx0 = await loadAccessContext(db, demo.users.lars.user.id);
    const clubId = (await registerClub(db, ctx0, { name: "Guideklub", slug: null })).id;
    const ctx = await loadAccessContext(db, demo.users.lars.user.id);
    let steps = await onboardingSteps(db, ctx, clubId);
    expect(steps.find((s) => s.key === "teams")!.done).toBe(false);
    await createTeam(db, ctx, clubId, "U9");
    steps = await onboardingSteps(db, ctx, clubId);
    expect(steps.find((s) => s.key === "teams")!.done).toBe(true);
    const other = await loadAccessContext(db, demo.users.niklas.user.id);
    await expect(onboardingSteps(db, other, clubId)).rejects.toThrow();
  });
});
