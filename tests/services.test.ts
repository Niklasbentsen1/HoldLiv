// Kører mod en rigtig Postgres (TEST_DATABASE_URL). Databasen nulstilles før testene.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "../src/db/client";
import { seedDemo } from "../src/db/demo";
import { eventResponses, guardianships, profiles } from "../src/db/schema";
import { loadAccessContext, loadActingProfiles } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import {
  addTeamMember,
  createChildProfile,
  createEvent,
  listUpcomingEvents,
  registerUser,
  respondToEvent,
  revokeClubAdmin,
  updateProfile,
} from "../src/services";

const url = process.env.TEST_DATABASE_URL ?? "postgres://holdliv:holdliv@localhost:5432/holdliv_test";
const { db, sql } = createDb(url);
let demo: Awaited<ReturnType<typeof seedDemo>>;

beforeAll(async () => {
  await sql.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await migrate(db, { migrationsFolder: "./drizzle" });
  demo = await seedDemo(db);
});

afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);

describe("Niklas: spiller, far og bestyrelsesmedlem", () => {
  it("kan skifte mellem sig selv og Emma", async () => {
    const ctx = await ctxOf("niklas");
    const acting = await loadActingProfiles(db, ctx);
    expect(acting.map((p) => p.firstName)).toEqual(["Niklas", "Emma"]);
  });

  it("ser Emmas U9-aktiviteter, når han agerer som Emma, og sine egne som sig selv", async () => {
    const ctx = await ctxOf("niklas");
    const asEmma = await listUpcomingEvents(db, ctx, demo.emma.id);
    expect(asEmma.map((e) => e.teamName)).toEqual(["U9 piger", "U9 piger"]);
    const asSelf = await listUpcomingEvents(db, ctx, ctx.profileId);
    expect(asSelf.map((e) => e.teamName)).toEqual(["Senior herrer"]);
  });

  it("melder Emma fra, og svaret viser at det var ham der trykkede", async () => {
    const ctx = await ctxOf("niklas");
    await respondToEvent(db, ctx, demo.events.u9Match.id, demo.emma.id, "no", "Til fødselsdag");
    const [r] = await db
      .select()
      .from(eventResponses)
      .where(and(eq(eventResponses.eventId, demo.events.u9Match.id), eq(eventResponses.profileId, demo.emma.id)));
    expect(r.status).toBe("no");
    expect(r.respondedByUserId).toBe(demo.users.niklas.user.id);

    // Ombestemmer sig: samme række opdateres.
    await respondToEvent(db, ctx, demo.events.u9Match.id, demo.emma.id, "yes");
    const [events] = await Promise.all([listUpcomingEvents(db, ctx, demo.emma.id)]);
    expect(events.find((e) => e.id === demo.events.u9Match.id)?.status).toBe("yes");
  });

  it("som admin kan han udpege trænere", async () => {
    const ctx = await ctxOf("niklas");
    await addTeamMember(db, ctx, demo.teams.senior.id, demo.users.mette.profile.id, "coach");
  });
});

describe("Mette: træner for U9", () => {
  it("opretter aktiviteter for sit eget hold", async () => {
    const ctx = await ctxOf("mette");
    await createEvent(db, ctx, demo.teams.u9.id, { type: "training", title: "Ekstra træning", startsAt: new Date(Date.now() + 864e5) });
  });

  it("spillere kan ikke oprette aktiviteter", async () => {
    const jonas = await ctxOf("jonas");
    await expect(
      createEvent(db, jonas, demo.teams.senior.id, { type: "training", title: "x", startsAt: new Date() }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("registrerer fremmøde for en spiller, men kan ikke rette barnets personoplysninger", async () => {
    const ctx = await ctxOf("mette");
    await respondToEvent(db, ctx, demo.events.u9Training.id, demo.emma.id, "yes");
    await expect(updateProfile(db, ctx, demo.emma.id, { phone: "12345678" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("kan ikke selv gøre sig til træner på andre hold", async () => {
    const other = await registerUser(db, "ny@holdliv.test", { firstName: "Ny", lastName: "Træner" });
    const ctx = await loadAccessContext(db, other.user.id);
    await expect(addTeamMember(db, ctx, demo.teams.u9.id, ctx.profileId, "coach")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Jonas: almindelig spiller", () => {
  it("kan ikke melde Emma til og kan ikke se Emmas aktiviteter", async () => {
    const ctx = await ctxOf("jonas");
    await expect(respondToEvent(db, ctx, demo.events.u9Match.id, demo.emma.id, "yes")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listUpcomingEvents(db, ctx, demo.emma.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("kan ikke melde sig til et hold han ikke er på", async () => {
    const ctx = await ctxOf("jonas");
    await expect(respondToEvent(db, ctx, demo.events.u9Match.id, ctx.profileId, "yes")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("børneprofiler", () => {
  it("kan ikke oprettes for voksne", async () => {
    const ctx = await ctxOf("jonas");
    await expect(createChildProfile(db, ctx, { firstName: "A", lastName: "B", birthDate: "1990-01-01" })).rejects.toThrow();
  });

  it("forælderen mister værgeadgangen, når barnet fylder 18", async () => {
    const ctx = await ctxOf("jonas");
    const kid = await createChildProfile(db, ctx, { firstName: "Liva", lastName: "Krogh", birthDate: "2009-03-01" });
    expect((await ctxOf("jonas")).wards.has(kid.id)).toBe(true);
    const later = await loadAccessContext(db, demo.users.jonas.user.id, new Date("2027-03-02T12:00:00Z"));
    expect(later.wards.has(kid.id)).toBe(false);
    // Relationen bevares i databasen, så historikken stadig kan vises.
    const rows = await db.select().from(guardianships).where(eq(guardianships.childProfileId, kid.id));
    expect(rows).toHaveLength(1);
  });

  it("et barn kan senere få eget login og beholde forælderen som værge", async () => {
    const kidUser = await registerUser(db, "emma@holdliv.test", { firstName: "tmp", lastName: "tmp" });
    // Flyt login'et over på Emmas eksisterende profil (svarer til "Giv Emma eget login").
    await db.delete(profiles).where(eq(profiles.id, kidUser.profile.id));
    await db.update(profiles).set({ userId: kidUser.user.id }).where(eq(profiles.id, demo.emma.id));

    const emmaCtx = await loadAccessContext(db, kidUser.user.id);
    await respondToEvent(db, emmaCtx, demo.events.u9Training.id, demo.emma.id, "maybe");
    const niklas = await ctxOf("niklas");
    expect(niklas.wards.has(demo.emma.id)).toBe(true);
  });
});

describe("foreningen", () => {
  it("kan ikke miste sin sidste admin", async () => {
    const karen = await ctxOf("karen");
    await revokeClubAdmin(db, karen, demo.club.id, demo.users.niklas.profile.id);
    await expect(revokeClubAdmin(db, karen, demo.club.id, demo.users.karen.profile.id)).rejects.toThrow(/mindst én admin/);
  });
});
