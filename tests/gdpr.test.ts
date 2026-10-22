// GDPR: samtykker, dataudtræk og sletning, mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { auditLog, charges, chatMessages, clubMemberships, eventResponses, posts, profiles, users } from "../src/db/schema";
import {
  addClubMember,
  createChildProfile,
  createClub,
  createSingleCharge,
  deleteChildProfile,
  deleteMyAccount,
  exportMyData,
  grantClubAdmin,
  hasConsent,
  listConsents,
  previewDeletion,
  recordPrivacyConsent,
  registerUser,
  setConsent,
  createPost,
  type Deliver,
} from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
const deliver: Deliver = { baseUrl: "https://holdliv.test", mail: async () => {}, sms: null };

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);

/** En ny forælder med ét barn, medlem af foreningen, så sletningen ikke rører demoens data. */
async function newParent(tag: string) {
  const karen = await ctxOf("karen");
  const p = await registerUser(db, `${tag}@gdpr.test`, { firstName: "Per", lastName: tag, phone: "12345678", birthDate: "1985-01-01" });
  await addClubMember(db, karen, demo.club.id, p.profile.id);
  const ctx0 = await loadAccessContext(db, p.user.id);
  const child = await createChildProfile(db, ctx0, { firstName: "Lille", lastName: tag, birthDate: "2017-01-01" });
  await addClubMember(db, karen, demo.club.id, child.id);
  return { p, child, ctx: await loadAccessContext(db, p.user.id) };
}

describe("samtykker", () => {
  it("gives og trækkes tilbage med historik, og kun af personen eller værgen", async () => {
    const { p, child, ctx } = await newParent("samtykke");
    await recordPrivacyConsent(db, p.user.id, p.profile.id);
    expect((await listConsents(db, ctx, p.profile.id)).find((c) => c.kind === "privacy")?.granted).toBe(true);
    expect(await hasConsent(db, child.id, "photos")).toBe(false);
    await setConsent(db, ctx, child.id, "photos", true); // værgen for barnet
    expect(await hasConsent(db, child.id, "photos")).toBe(true);
    await setConsent(db, ctx, child.id, "photos", false);
    expect(await hasConsent(db, child.id, "photos")).toBe(false);
    const rows = await sql`select withdrawn_at from consents where profile_id = ${child.id}`;
    expect(rows).toHaveLength(1); // historikken bevares
    expect(rows[0].withdrawn_at).not.toBeNull();
    await expect(setConsent(db, ctx, p.profile.id, "privacy", false)).rejects.toThrow(/kan ikke trækkes/);
    await expect(setConsent(db, await ctxOf("ali"), child.id, "photos", true)).rejects.toThrow();
    await expect(listConsents(db, await ctxOf("ali"), child.id)).rejects.toThrow();
  });
});

describe("dataudtræk", () => {
  it("indeholder egne og børnenes data, men ikke andres", async () => {
    const { ctx, child } = await newParent("udtraek");
    await createPost(db, ctx, deliver, { kind: "board", scope: `club:${demo.club.id}`, title: "Mit opslag", body: "Hej" });
    const out = await exportMyData(db, ctx);
    expect(out.account.email).toBe("udtraek@gdpr.test");
    expect(out.people).toHaveLength(2);
    const me = out.people.find((x) => x.self)!;
    expect(me.profile).toMatchObject({ firstName: "Per", phone: "12345678" });
    expect(me.posts.map((x) => x.title)).toEqual(["Mit opslag"]);
    expect(me.clubMemberships[0].club).toBe("Skovby IF");
    expect(out.people.find((x) => !x.self)!.profile?.firstName).toBe("Lille");
    // Intet om fremmede.
    expect(JSON.stringify(out)).not.toContain("karen@holdliv.test");
    const log = await db.select().from(auditLog).where(eq(auditLog.action, "gdpr.exported"));
    expect(log.length).toBeGreaterThan(0);
    expect(child.id).toBeTruthy();
  });
});

describe("sletning", () => {
  it("anonymiserer personen og barnet, beholder opkrævninger og fjerner login og indhold", async () => {
    const { p, child, ctx } = await newParent("slet");
    const karen = await ctxOf("karen");
    await createSingleCharge(db, karen, demo.club.id, p.profile.id, { description: "Tøjsæt", amountOre: 20000, dueDate: "2026-12-01" } as never);
    await sql`update charges set status = 'paid', paid_at = now() where profile_id = ${p.profile.id}`;
    await createPost(db, ctx, deliver, { kind: "board", scope: `club:${demo.club.id}`, title: "Skal væk", body: "x" });

    await expect(deleteMyAccount(db, ctx, "forkert@mail.dk")).rejects.toThrow(/bekræfte/);
    await deleteMyAccount(db, ctx, "SLET@gdpr.test");

    expect(await db.select().from(users).where(eq(users.email, "slet@gdpr.test"))).toEqual([]);
    const people = await db.select().from(profiles).where(eq(profiles.id, p.profile.id));
    expect(people[0]).toMatchObject({ firstName: "Slettet", lastName: "medlem", phone: null, email: null, birthDate: null, userId: null });
    expect(people[0].deletedAt).not.toBeNull();
    const kid = await db.select().from(profiles).where(eq(profiles.id, child.id));
    expect(kid[0]).toMatchObject({ firstName: "Slettet", birthDate: null });
    expect(await db.select().from(posts).where(eq(posts.authorProfileId, p.profile.id))).toEqual([]);
    expect(await db.select().from(clubMemberships).where(eq(clubMemberships.profileId, p.profile.id))).toEqual([]);
    expect(await db.select().from(chatMessages).where(eq(chatMessages.authorProfileId, p.profile.id))).toEqual([]);
    // Den betalte opkrævning bevares, nu uden navn.
    const kept = await db.select().from(charges).where(eq(charges.profileId, p.profile.id));
    expect(kept).toHaveLength(1);
    expect(kept[0].amountOre).toBe(20000);
  });

  it("blokeres af ubetalte opkrævninger og af at være eneste admin", async () => {
    const { p, ctx } = await newParent("blok");
    const karen = await ctxOf("karen");
    await createSingleCharge(db, karen, demo.club.id, p.profile.id, { description: "Stævne", amountOre: 5000, dueDate: "2026-12-01" } as never);
    expect((await previewDeletion(db, ctx)).blockers.join(" ")).toMatch(/ubetalte/);
    await expect(deleteMyAccount(db, ctx, "blok@gdpr.test")).rejects.toThrow(/ubetalte/);
    // Den der opretter en forening, er dens eneste admin.
    const boss = await registerUser(db, "formand@gdpr.test", { firstName: "Fa", lastName: "Mand", birthDate: "1970-01-01" });
    await createClub(db, await loadAccessContext(db, boss.user.id), "Lille IF", "lille-if");
    const bossCtx = await loadAccessContext(db, boss.user.id);
    expect((await previewDeletion(db, bossCtx)).blockers.join(" ")).toMatch(/eneste admin/);
    await expect(deleteMyAccount(db, bossCtx, "formand@gdpr.test")).rejects.toThrow(/eneste admin/);
    // Med en ekstra admin er vejen fri.
    const other = await registerUser(db, "admin2@gdpr.test", { firstName: "To", lastName: "Admin", birthDate: "1980-01-01" });
    await grantClubAdmin(db, bossCtx, bossCtx.adminClubs.values().next().value as string, other.profile.id);
    expect((await previewDeletion(db, bossCtx)).blockers.join(" ")).not.toMatch(/eneste admin/);
  });

  it("et barn med en anden værge bliver, når den ene forælder sletter sig", async () => {
    // Freja har to værger: Anne og Lars. Her bruger vi en ny konstellation for ikke at røre demoen.
    const { p, child } = await newParent("toforaeldre");
    const second = await registerUser(db, "toforaeldre2@gdpr.test", { firstName: "Pia", lastName: "Anden", birthDate: "1986-01-01" });
    const { addGuardian } = await import("../src/services");
    await addGuardian(db, await loadAccessContext(db, p.user.id), child.id, second.profile.id);
    await deleteMyAccount(db, await loadAccessContext(db, p.user.id), "toforaeldre@gdpr.test");
    const kid = await db.select().from(profiles).where(eq(profiles.id, child.id));
    expect(kid[0].firstName).toBe("Lille");
    expect((await loadAccessContext(db, second.user.id)).wards.has(child.id)).toBe(true);
  });

  it("en værge kan slette et barns data, og kun sit eget barn", async () => {
    const { child, ctx } = await newParent("barn");
    await expect(deleteChildProfile(db, await ctxOf("ali"), child.id)).rejects.toThrow();
    await db.insert(eventResponses).values({ eventId: (await sql`select id from events limit 1`)[0].id, profileId: child.id, status: "yes", respondedByUserId: ctx.userId });
    await deleteChildProfile(db, ctx, child.id);
    expect(await db.select().from(eventResponses).where(eq(eventResponses.profileId, child.id))).toEqual([]);
    expect((await db.select().from(profiles).where(eq(profiles.id, child.id)))[0].deletedAt).not.toBeNull();
  });
});
