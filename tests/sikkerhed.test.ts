// To-faktor (TOTP), nødkoder og revisionslog, mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { createSession, resolveSession } from "../src/auth/login";
import { beginTotpSetup, completeMfa, isMfaPending, LOCK_MINUTES, confirmTotpSetup, disableTotp, MAX_MFA_ATTEMPTS, mfaStatus, regenerateRecoveryCodes } from "../src/auth/mfa";
import { base32Decode, base32Encode, codeAt, matchStep, openSecret, sealSecret, stepOf } from "../src/lib/totp";
import { users } from "../src/db/schema";
import { grantClubAdmin, listAudit, membersCsv, registerUser, addClubMember } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const t0 = new Date("2026-11-01T12:00:00Z");
const at = (secs: number) => new Date(t0.getTime() + secs * 1000);

describe("TOTP", () => {
  it("følger RFC 6238-testvektoren", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(codeAt(secret, Math.floor(59 / 30))).toBe("287082");
    expect(codeAt(secret, Math.floor(1111111109 / 30))).toBe("081804");
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
  });

  it("tillader et tidsrum fra hver side, men ikke mere", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const step = stepOf(t0);
    expect(matchStep(secret, codeAt(secret, step - 1), t0)).toBe(step - 1);
    expect(matchStep(secret, codeAt(secret, step + 1), t0)).toBe(step + 1);
    expect(matchStep(secret, codeAt(secret, step - 2), t0)).toBeNull();
    expect(matchStep(secret, "abcdef", t0)).toBeNull();
  });

  it("krypterer hemmeligheden, når nøglen er sat", () => {
    process.env.TOTP_ENC_KEY = "ab".repeat(32);
    try {
      const sealed = sealSecret("JBSWY3DPEHPK3PXP");
      expect(sealed.startsWith("v1:")).toBe(true);
      expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
      expect(openSecret(sealed)).toBe("JBSWY3DPEHPK3PXP");
    } finally {
      delete process.env.TOTP_ENC_KEY;
    }
  });
});

describe("to-faktor ved login", () => {
  it("opsætning, afventende session, genafspilning og nødkoder", async () => {
    const userId = demo.users.karen.user.id;
    expect((await mfaStatus(db, userId)).enabled).toBe(false);
    // Uden to-faktor er sessionen fri med det samme.
    const plain = await createSession(db, userId);
    expect(plain.mfaPending).toBe(false);
    expect(await resolveSession(db, plain.token)).toBe(userId);

    const { secret } = await beginTotpSetup(db, userId);
    await expect(confirmTotpSetup(db, userId, "000000", t0)).rejects.toThrow(/passer ikke/);
    expect((await mfaStatus(db, userId)).enabled).toBe(false);
    const codes = await confirmTotpSetup(db, userId, codeAt(secret, stepOf(t0)), t0);
    expect(codes).toHaveLength(8);
    expect(await mfaStatus(db, userId)).toMatchObject({ enabled: true, recoveryLeft: 8, privileged: true });

    // Andre sessioner fra før to-faktor blev slået til er logget ud.
    expect(await resolveSession(db, plain.token, t0)).toBeNull();

    // Nu er en ny session afventende og giver ingen adgang.
    const s = await createSession(db, userId, t0);
    expect(s.mfaPending).toBe(true);
    expect(await resolveSession(db, s.token, t0)).toBeNull();
    expect(await isMfaPending(db, s.token, t0)).toBe(true);
    await expect(completeMfa(db, s.token, "123456", at(60))).rejects.toThrow(/Forkert/);
    expect(await resolveSession(db, s.token, at(60))).toBeNull();
    // Koden fra opsætningen kan ikke bruges igen (genafspilning).
    await expect(completeMfa(db, s.token, codeAt(secret, stepOf(t0)), t0)).rejects.toThrow(/allerede brugt/);
    await completeMfa(db, s.token, codeAt(secret, stepOf(at(60))), at(60));
    expect(await resolveSession(db, s.token, at(60))).toBe(userId);
    expect(await isMfaPending(db, s.token, at(60))).toBe(false);

    // Nødkode virker én gang.
    const s2 = await createSession(db, userId, at(120));
    await completeMfa(db, s2.token, codes[0], at(120));
    const s3 = await createSession(db, userId, at(121));
    await expect(completeMfa(db, s3.token, codes[0], at(121))).rejects.toThrow(/Forkert/);
    expect((await mfaStatus(db, userId)).recoveryLeft).toBe(7);

    // Nye nødkoder gør de gamle ugyldige.
    const fresh = await regenerateRecoveryCodes(db, userId, codeAt(secret, stepOf(at(150))), at(150));
    const s4 = await createSession(db, userId, at(151));
    await expect(completeMfa(db, s4.token, codes[1], at(151))).rejects.toThrow(/Forkert/);
    await completeMfa(db, s4.token, fresh[0], at(151));
  });

  it("spærrer efter for mange forkerte forsøg", async () => {
    const userId = demo.users.karen.user.id;
    const s = await createSession(db, userId, at(300));
    for (let i = 0; i < MAX_MFA_ATTEMPTS; i++) await expect(completeMfa(db, s.token, "111111", at(300))).rejects.toThrow(/Forkert/);
    await expect(completeMfa(db, s.token, "111111", at(300))).rejects.toThrow(/For mange/);
    await expect(completeMfa(db, s.token, "111111", at(300))).rejects.toThrow(/udløbet/);
  });

  it("kan slås fra, medmindre det er påkrævet", async () => {
    const userId = demo.users.karen.user.id;
    await sql`update users set totp_failures = 0, totp_locked_until = null where id = ${userId}`;
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    const secret = openSecret(u.totpSecret!);
    process.env.REQUIRE_2FA = "1";
    try {
      await expect(disableTotp(db, userId, codeAt(secret, stepOf(at(600))), at(600))).rejects.toThrow(/skal du bruge/);
    } finally {
      delete process.env.REQUIRE_2FA;
    }
    await disableTotp(db, userId, codeAt(secret, stepOf(at(600))), at(600));
    expect((await mfaStatus(db, userId)).enabled).toBe(false);
    expect((await createSession(db, userId, at(700))).mfaPending).toBe(false);
  });
});

describe("loft over forsøg pr. konto", () => {
  it("låser to-faktor efter for mange forkerte koder, også ved slå fra og nye nødkoder", async () => {
    const userId = demo.users.henrik.user.id;
    const { secret } = await beginTotpSetup(db, userId);
    await confirmTotpSetup(db, userId, codeAt(secret, stepOf(at(1000))), at(1000));
    for (let i = 0; i < MAX_MFA_ATTEMPTS; i++) await expect(regenerateRecoveryCodes(db, userId, "111111", at(1010))).rejects.toThrow(/Forkert/);
    // Nu er kontoen låst, selv med den rigtige kode.
    const good = codeAt(secret, stepOf(at(1020)));
    await expect(regenerateRecoveryCodes(db, userId, good, at(1020))).rejects.toThrow(/For mange/);
    await expect(disableTotp(db, userId, good, at(1020))).rejects.toThrow(/For mange/);
    // Efter låsetiden virker den rigtige kode igen.
    const later = at(1020 + LOCK_MINUTES * 60 + 60);
    await regenerateRecoveryCodes(db, userId, codeAt(secret, stepOf(later)), later);
  });
});

describe("revisionslog", () => {
  it("noterer roller, medlemmer, eksport og to-faktor, og kun admin kan læse den", async () => {
    const karen = await ctxOf("karen");
    const u = await registerUser(db, "ny-admin@holdliv.test", { firstName: "Ny", lastName: "Admin" });
    await addClubMember(db, karen, demo.club.id, u.profile.id);
    await grantClubAdmin(db, karen, demo.club.id, u.profile.id);
    await membersCsv(db, karen, demo.club.id);
    const { rows } = await listAudit(db, karen, demo.club.id);
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["club.member_added", "club.admin_granted", "members.exported", "mfa.enabled", "mfa.disabled"]));
    expect(rows.find((r) => r.action === "club.admin_granted")?.actorEmail).toBe(demo.users.karen.user.email);
    await expect(listAudit(db, await ctxOf("sofie"), demo.club.id)).rejects.toThrow();
  });
});
