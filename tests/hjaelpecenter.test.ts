// Hjælpecenter: søgning i artiklerne og henvendelser til support (mod en rigtig Postgres).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ARTICLES, AUDIENCES, findArticle, searchArticles } from "../src/lib/hjaelpeartikler";
import { listMySupportRequests, MAX_REQUESTS_PER_DAY, submitSupportRequest } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
});
afterAll(() => sql.end());

describe("hjælpeartikler", () => {
  it("har unikke adresser og kun kendte målgrupper", () => {
    expect(new Set(ARTICLES.map((a) => a.slug)).size).toBe(ARTICLES.length);
    for (const a of ARTICLES) for (const au of a.audiences) expect(AUDIENCES).toHaveProperty(au);
    for (const au of Object.keys(AUDIENCES)) expect(searchArticles("", au as keyof typeof AUDIENCES).length).toBeGreaterThan(0);
  });

  it("søger i titel, søgeord og tekst, også uden æøå", () => {
    expect(searchArticles("import")[0].slug).toBe("flyt-medlemmer");
    expect(searchArticles("klubmodul")[0].slug).toBe("flyt-medlemmer");
    expect(searchArticles("boern").map((a) => a.slug)).toContain("boern-og-familie");
    expect(searchArticles("børn").map((a) => a.slug)).toContain("boern-og-familie");
    expect(searchArticles("rykker")[0].slug).toBe("kontingent");
    expect(searchArticles("zzzxqj")).toEqual([]);
  });

  it("filtrerer på målgruppe og finder artikel på adresse", () => {
    expect(searchArticles("betal", "foraelder").every((a) => a.audiences.includes("foraelder"))).toBe(true);
    expect(searchArticles("pris", "traener").map((a) => a.slug)).not.toContain("kontingent");
    expect(findArticle("log-ind")?.title).toMatch(/logger/);
    expect(findArticle("findes-ikke")).toBeNull();
  });
});

describe("support", () => {
  it("gemmer henvendelsen med svar-e-mail og sender mail til support", async () => {
    const ctx = await loadAccessContext(db, demo.users.mette.user.id);
    const send = vi.fn().mockResolvedValue(undefined);
    const r = await submitSupportRequest(db, ctx, { subject: "  Hjælp   til import ", message: "Den fejler" }, { send, to: "support@holdliv.test" });
    expect(r.subject).toBe("Hjælp til import");
    expect(r.replyEmail).toBe("mette@holdliv.test");
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBe("support@holdliv.test");
    expect((await listMySupportRequests(db, ctx)).map((x) => x.id)).toContain(r.id);
  });

  it("gemmer også når mail fejler, og uden SUPPORT_EMAIL", async () => {
    const ctx = await loadAccessContext(db, demo.users.jonas.user.id);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await submitSupportRequest(db, ctx, { subject: "a", message: "b" }, { send: vi.fn().mockRejectedValue(new Error("nede")), to: "s@x.dk" });
    expect(r.id).toBeTruthy();
    await submitSupportRequest(db, ctx, { subject: "c", message: "d" });
  });

  it("afviser tomme og for lange, og andres foreninger knyttes ikke på", async () => {
    const ctx = await loadAccessContext(db, demo.users.peter.user.id);
    await expect(submitSupportRequest(db, ctx, { subject: "", message: "x" })).rejects.toThrow();
    await expect(submitSupportRequest(db, ctx, { subject: "x", message: "" })).rejects.toThrow();
    await expect(submitSupportRequest(db, ctx, { subject: "x", message: "y".repeat(3001) })).rejects.toThrow(/højst/);
    const r = await submitSupportRequest(db, ctx, { subject: "x", message: "y", clubId: demo.club.id });
    expect(r.clubId).toBeNull();
  });

  it("holder døgngrænsen, også ved samtidige kald, og kun egne henvendelser vises", async () => {
    const u = demo.users.ali.user.id;
    const results = await Promise.allSettled(Array.from({ length: 12 }, async (_, i) => submitSupportRequest(db, await loadAccessContext(db, u), { subject: `s${i}`, message: "m" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(MAX_REQUESTS_PER_DAY);
    expect(await listMySupportRequests(db, await loadAccessContext(db, u))).toHaveLength(MAX_REQUESTS_PER_DAY);
    expect(await listMySupportRequests(db, await loadAccessContext(db, demo.users.lars.user.id))).toHaveLength(0);
  });
});
