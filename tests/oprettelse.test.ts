// Kører mod en rigtig Postgres (TEST_DATABASE_URL).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { clubRoles } from "../src/db/schema";
import { loadAccessContext } from "../src/auth/context";
import { checkSlug, createTeam, MAX_CLUBS_PER_CREATOR, onboardingSteps, registerClub, slugify } from "../src/services";

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

  it("begrænser antal foreninger pr. opretter", async () => {
    const u = demo.users.ali.user.id;
    for (let i = 0; i < MAX_CLUBS_PER_CREATOR + 2; i++) {
      const ctx = await loadAccessContext(db, u);
      if (ctx.adminClubs.size >= MAX_CLUBS_PER_CREATOR) {
        await expect(registerClub(db, ctx, { name: `Klub ${i}`, slug: null })).rejects.toThrow(/højst/);
        return;
      }
      await registerClub(db, ctx, { name: `Klub ${i}`, slug: null });
    }
    throw new Error("grænsen blev aldrig ramt");
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
