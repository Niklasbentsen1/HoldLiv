import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { loginTokens, users } from "../src/db/schema";
import {
  LoginError,
  MAX_REQUESTS_PER_HOUR,
  createSession,
  deleteSession,
  requestLogin,
  resolveSession,
  verifyCode,
  verifyLink,
} from "../src/auth/login";

const { db, sql, reset } = testDb();
beforeAll(reset);
afterAll(() => sql.end());

describe("login med kode", () => {
  it("opretter login'et første gang e-mailen bekræftes, og genbruger det bagefter", async () => {
    const { code } = await requestLogin(db, " Ny@Forælder.dk ");
    const userId = await verifyCode(db, "ny@forælder.dk", code);
    const [u] = await db.select().from(users).where(eq(users.id, userId));
    expect(u.email).toBe("ny@forælder.dk");

    const again = await requestLogin(db, "ny@forælder.dk");
    expect(await verifyCode(db, "ny@forælder.dk", again.code)).toBe(userId);
  });

  it("gemmer ikke koden i klar tekst", async () => {
    const { code, email } = await requestLogin(db, "hash@test.dk");
    const rows = await db.select().from(loginTokens).where(eq(loginTokens.email, email));
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it("en kode virker kun én gang", async () => {
    const { code } = await requestLogin(db, "once@test.dk");
    await verifyCode(db, "once@test.dk", code);
    await expect(verifyCode(db, "once@test.dk", code)).rejects.toBeInstanceOf(LoginError);
  });

  it("afviser forkert kode og låser efter for mange forsøg", async () => {
    const { code } = await requestLogin(db, "guess@test.dk");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(verifyCode(db, "guess@test.dk", wrong)).rejects.toThrow(/Forkert kode/);
    await expect(verifyCode(db, "guess@test.dk", code)).rejects.toThrow(/For mange/);
  });

  it("udløber efter 15 minutter", async () => {
    const t0 = new Date("2026-10-22T10:00:00Z");
    const { code } = await requestLogin(db, "late@test.dk", t0);
    await expect(verifyCode(db, "late@test.dk", code, new Date("2026-10-22T10:16:00Z"))).rejects.toThrow(/udløbet/);
  });

  it("begrænser antal koder pr. time", async () => {
    for (let i = 0; i < MAX_REQUESTS_PER_HOUR; i++) await requestLogin(db, "spam@test.dk");
    await expect(requestLogin(db, "spam@test.dk")).rejects.toThrow(/For mange/);
  });

  it("afviser ugyldige e-mails", async () => {
    await expect(requestLogin(db, "ikke-en-mail")).rejects.toBeInstanceOf(LoginError);
  });
});

describe("login med link", () => {
  it("logger ind én gang med linket", async () => {
    const { linkToken } = await requestLogin(db, "link@test.dk");
    const userId = await verifyLink(db, linkToken);
    expect(userId).toBeTruthy();
    await expect(verifyLink(db, linkToken)).rejects.toBeInstanceOf(LoginError);
  });
});

describe("sessioner", () => {
  it("kan slås op, udløber og kan logges ud", async () => {
    const { code } = await requestLogin(db, "session@test.dk");
    const userId = await verifyCode(db, "session@test.dk", code);
    const t0 = new Date();
    const { token } = await createSession(db, userId, t0);
    expect(await resolveSession(db, token)).toBe(userId);
    expect(await resolveSession(db, "forkert")).toBeNull();
    expect(await resolveSession(db, token, new Date(t0.getTime() + 31 * 86_400_000))).toBeNull();
    await deleteSession(db, token);
    expect(await resolveSession(db, token)).toBeNull();
  });
});
