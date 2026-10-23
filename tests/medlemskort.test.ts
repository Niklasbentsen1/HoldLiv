// Medlemskortet mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { checkCard, listMyCards, resetCard, setCardOverdueRule } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
let clubId: string;

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
  clubId = demo.club.id;
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const kid = (k: keyof typeof demo.kids) => demo.kids[k].id;
const cardOf = async (who: keyof typeof demo.users, profileId: string) => (await listMyCards(db, await ctxOf(who))).find((c) => c.profileId === profileId)!;

describe("medlemskort", () => {
  it("giver kort til sig selv og sine børn, men ikke til andres", async () => {
    const cards = await listMyCards(db, await ctxOf("niklas"));
    expect(cards.map((c) => c.name).sort()).toEqual(["Emma Bentsen", "Niklas Bentsen"]);
    expect(cards.every((c) => c.clubName === "Skovby IF")).toBe(true);
    expect(cards.find((c) => c.name === "Emma Bentsen")!.teams).toEqual(["U9 piger"]);
    const tokens = cards.map((c) => c.token);
    expect(new Set(tokens).size).toBe(2);
    // Samme kort ved næste visning.
    expect((await listMyCards(db, await ctxOf("niklas"))).map((c) => c.token).sort()).toEqual([...tokens].sort());
  });

  it("lader træner og admin scanne, og viser et gyldigt medlemskab", async () => {
    const emma = await cardOf("niklas", kid("emma"));
    const r = await checkCard(db, await ctxOf("mette"), emma.token);
    expect(r).toMatchObject({ found: true, valid: true, name: "Emma Bentsen", clubName: "Skovby IF", teams: ["U9 piger"], overdue: null });
    // Jonas er træner i foreningen (U11), så han må også scanne.
    expect(await checkCard(db, await ctxOf("jonas"), emma.token)).toMatchObject({ found: true, valid: true });
  });

  it("afviser forældre og fremmede, og ukendte koder", async () => {
    const emma = await cardOf("niklas", kid("emma"));
    await expect(checkCard(db, await ctxOf("ali"), emma.token)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await checkCard(db, await ctxOf("karen"), "findes-ikke-findes-ikke-findes")).toEqual({ found: false });
    expect(await checkCard(db, await ctxOf("karen"), "kort")).toEqual({ found: false });
  });

  it("viser kun admin og kasserer, om der er en forfalden opkrævning", async () => {
    // Noor har en forfalden opkrævning i demoen (se kontingent).
    const noor = await cardOf("ali", kid("noor"));
    const asTreasurer = await checkCard(db, await ctxOf("sofie"), noor.token);
    const asAdmin = await checkCard(db, await ctxOf("karen"), noor.token);
    const asCoach = await checkCard(db, await ctxOf("mette"), noor.token);
    expect(asTreasurer).toMatchObject({ found: true, overdue: true });
    expect(asAdmin).toMatchObject({ overdue: true });
    expect(asCoach).toMatchObject({ overdue: null });
    expect(JSON.stringify(asCoach)).not.toMatch(/overdue":true|amount|kr/);
  });

  it("er som standard gyldigt ved restance, men foreningen kan vælge ugyldigt uden at trænere ser hvorfor", async () => {
    const noor = await cardOf("ali", kid("noor"));
    expect(await checkCard(db, await ctxOf("mette"), noor.token)).toMatchObject({ valid: true, overdue: null });
    await expect(setCardOverdueRule(db, await ctxOf("mette"), clubId, true)).rejects.toBeInstanceOf(ForbiddenError);
    await setCardOverdueRule(db, await ctxOf("sofie"), clubId, true);
    const asCoach = await checkCard(db, await ctxOf("mette"), noor.token);
    expect(asCoach).toMatchObject({ valid: false, overdue: null });
    expect(await checkCard(db, await ctxOf("sofie"), noor.token)).toMatchObject({ valid: false, overdue: true });
    // Et medlem uden restance er stadig gyldigt.
    const noOverdue = await cardOf("anne", kid("freja"));
    expect(await checkCard(db, await ctxOf("sofie"), noOverdue.token)).toMatchObject({ valid: true, overdue: false });
    expect(await checkCard(db, await ctxOf("mette"), noOverdue.token)).toMatchObject({ valid: true });
    await setCardOverdueRule(db, await ctxOf("sofie"), clubId, false);
    expect(await checkCard(db, await ctxOf("mette"), noor.token)).toMatchObject({ valid: true });
  });

  it("gør kortet ugyldigt, når medlemmet melder sig ud, og igen gyldigt ved genindmeldelse", async () => {
    const emma = await cardOf("niklas", kid("emma"));
    await sql`update club_memberships set status = 'inactive' where club_id = ${clubId} and profile_id = ${kid("emma")}`;
    expect(await checkCard(db, await ctxOf("mette"), emma.token)).toMatchObject({ found: true, valid: false });
    // Udmeldte får ikke vist kortet i appen.
    expect((await listMyCards(db, await ctxOf("niklas"))).map((c) => c.name)).toEqual(["Niklas Bentsen"]);
    await sql`update club_memberships set status = 'active' where club_id = ${clubId} and profile_id = ${kid("emma")}`;
    expect(await checkCard(db, await ctxOf("mette"), emma.token)).toMatchObject({ valid: true });
  });

  it("nulstiller kortet, så det gamle ikke virker, og kun for sig selv og sine børn", async () => {
    const emma = await cardOf("niklas", kid("emma"));
    await expect(resetCard(db, await ctxOf("ali"), clubId, kid("emma"))).rejects.toBeInstanceOf(ForbiddenError);
    await resetCard(db, await ctxOf("niklas"), clubId, kid("emma"));
    expect(await checkCard(db, await ctxOf("karen"), emma.token)).toEqual({ found: false });
    const fresh = await cardOf("niklas", kid("emma"));
    expect(fresh.token).not.toBe(emma.token);
    expect(await checkCard(db, await ctxOf("karen"), fresh.token)).toMatchObject({ found: true, valid: true });
  });

  it("holder foreninger adskilt: en træner i en anden forening kan ikke scanne", async () => {
    const { createClub, registerUser } = await import("../src/services");
    const u = await registerUser(db, "anden@anden.test", { firstName: "Bo", lastName: "Anden" });
    await createClub(db, await loadAccessContext(db, u.user.id), "Anden IF", "anden-if");
    const emma = await cardOf("niklas", kid("emma"));
    await expect(checkCard(db, await loadAccessContext(db, u.user.id), emma.token)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
