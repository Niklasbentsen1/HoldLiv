// Mobilappens grænseflade: bearer-login, to-faktor, personer og aktiviteter, og push til telefoner.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { createSession, deleteSession } from "../src/auth/login";
import { beginTotpSetup, confirmTotpSetup } from "../src/auth/mfa";
import { codeAt, stepOf } from "../src/lib/totp";
import { DeviceGoneError, isExpoToken, type DevicePushMessage } from "../src/lib/devicePush";
import { deviceTokens } from "../src/db/schema";
import { authenticateMobile, mobileEvents, mobilePeople, notifyUsers, registerDevice, removeDevice, type Deliver, MobileAuthError } from "../src/services";
import { loadAccessContext } from "../src/auth/context";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
const sent: { token: string; msg: DevicePushMessage }[] = [];
let gone = new Set<string>();
const deliver: Deliver = {
  baseUrl: "https://holdliv.test",
  mail: async () => {},
  sms: null,
  devicePush: async (token, msg) => {
    if (gone.has(token)) throw new DeviceGoneError("væk");
    sent.push({ token, msg });
  },
};
const TOKEN = (n: number) => `ExponentPushToken[abc${n}]`;

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  sent.length = 0;
  gone = new Set();
  await sql`delete from notifications`;
  await sql`delete from device_tokens`;
});

const bearer = (t: string) => `Bearer ${t}`;
const login = async (key: keyof typeof demo.users) => createSession(db, demo.users[key].user.id);

describe("bearer-login", () => {
  it("kræver et gyldigt token", async () => {
    await expect(authenticateMobile(db, null)).rejects.toBeInstanceOf(MobileAuthError);
    await expect(authenticateMobile(db, "Bearer forkert")).rejects.toThrow(/udløbet/);
    const s = await login("sofie");
    const { ctx } = await authenticateMobile(db, bearer(s.token));
    expect(ctx.userId).toBe(demo.users.sofie.user.id);
    await deleteSession(db, s.token);
    await expect(authenticateMobile(db, bearer(s.token))).rejects.toThrow(/udløbet/);
  });

  it("en session der afventer to-faktor giver ingen adgang", async () => {
    const userId = demo.users.henrik.user.id;
    const { secret } = await beginTotpSetup(db, userId);
    await confirmTotpSetup(db, userId, codeAt(secret, stepOf(new Date())));
    const s = await createSession(db, userId);
    expect(s.mfaPending).toBe(true);
    await expect(authenticateMobile(db, bearer(s.token))).rejects.toThrow(/udløbet/);
  });

  it("admin uden to-faktor afvises, når det er påkrævet", async () => {
    const s = await login("karen");
    process.env.REQUIRE_2FA = "1";
    try {
      await expect(authenticateMobile(db, bearer(s.token))).rejects.toMatchObject({ status: 403 });
      // Almindelige medlemmer berøres ikke.
      expect((await authenticateMobile(db, bearer((await login("ali")).token))).ctx.userId).toBe(demo.users.ali.user.id);
    } finally {
      delete process.env.REQUIRE_2FA;
    }
  });
});

describe("personer og aktiviteter", () => {
  it("forælderen ser sig selv og sine børn og kan hente børnenes aktiviteter, men ikke fremmedes", async () => {
    const anne = await loadAccessContext(db, demo.users.anne.user.id);
    const people = await mobilePeople(db, anne);
    expect(people.filter((p) => p.self)).toHaveLength(1);
    expect(people.map((p) => p.name)).toEqual(expect.arrayContaining(["Freja Møller"]));
    const child = people.find((p) => !p.self)!;
    expect(Array.isArray(await mobileEvents(db, anne, child.id))).toBe(true);
    const ali = await loadAccessContext(db, demo.users.ali.user.id);
    await expect(mobileEvents(db, ali, child.id)).rejects.toThrow();
  });
});

describe("push til telefoner", () => {
  it("genkender Expo-adresser og afviser alt andet", async () => {
    expect(isExpoToken("ExponentPushToken[xxxx-yyyy]")).toBe(true);
    expect(isExpoToken("https://example.com/hack")).toBe(false);
    const s = await login("sofie");
    const { ctx, sessionId } = await authenticateMobile(db, bearer(s.token));
    await expect(registerDevice(db, ctx, sessionId, { token: "tilfældig", platform: "ios" })).rejects.toThrow(/Ugyldig/);
    await expect(registerDevice(db, ctx, sessionId, { token: TOKEN(1), platform: "windows" })).rejects.toThrow(/platform/);
  });

  it("sender til tilmeldte telefoner, rydder afmeldte og følger sessionen", async () => {
    const sofie = demo.users.sofie.user;
    const s = await login("sofie");
    const { ctx, sessionId } = await authenticateMobile(db, bearer(s.token));
    await registerDevice(db, ctx, sessionId, { token: TOKEN(1), platform: "ios" });
    await registerDevice(db, ctx, sessionId, { token: TOKEN(2), platform: "android" });
    const rec = [{ userId: sofie.id, email: sofie.email, phone: null }];
    const msg = { kind: "event_change" as const, subject: "Aflyst", body: "Træning aflyst", sms: "Aflyst", url: "/aktivitet/1" };

    gone.add(TOKEN(2));
    await notifyUsers(db, deliver, rec, { ...msg, dedupeKey: "a" });
    expect(sent.map((x) => x.token)).toEqual([TOKEN(1)]);
    expect(sent[0].msg).toMatchObject({ title: "Aflyst", url: "/aktivitet/1" });
    // Den afmeldte telefon er ryddet væk.
    expect((await db.select().from(deviceTokens)).map((d) => d.token)).toEqual([TOKEN(1)]);

    // Samme besked sendes ikke to gange.
    await notifyUsers(db, deliver, rec, { ...msg, dedupeKey: "a" });
    expect(sent).toHaveLength(1);

    // Slår man push fra for den slags besked, sendes intet.
    await sql`insert into notification_prefs (user_id, kind, channel, enabled) values (${sofie.id}, 'event_change', 'push', false)`;
    await notifyUsers(db, deliver, rec, { ...msg, dedupeKey: "b" });
    expect(sent).toHaveLength(1);
    await sql`delete from notification_prefs`;

    // Logud sletter telefonens adresse, så den ikke får beskeder bagefter.
    await deleteSession(db, s.token);
    expect(await db.select().from(deviceTokens)).toEqual([]);
    await notifyUsers(db, deliver, rec, { ...msg, dedupeKey: "c" });
    expect(sent).toHaveLength(1);
  });

  it("en anden bruger kan ikke overtage eller fjerne telefonens adresse", async () => {
    const s1 = await authenticateMobile(db, bearer((await login("sofie")).token));
    await registerDevice(db, s1.ctx, s1.sessionId, { token: TOKEN(5), platform: "ios" });
    const s2 = await authenticateMobile(db, bearer((await login("ali")).token));
    await removeDevice(db, s2.ctx, TOKEN(5));
    expect(await db.select().from(deviceTokens).where(eq(deviceTokens.token, TOKEN(5)))).toHaveLength(1);
    // Samme telefon, nyt login (fx ny bruger på telefonen): adressen flyttes til det nye login.
    await registerDevice(db, s2.ctx, s2.sessionId, { token: TOKEN(5), platform: "ios" });
    expect((await db.select().from(deviceTokens).where(eq(deviceTokens.token, TOKEN(5))))[0].userId).toBe(demo.users.ali.user.id);
  });
});
