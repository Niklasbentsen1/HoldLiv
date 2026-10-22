// Online indmeldelse: åbent link, aldersgrænser, godkendelse og overtagelse af forhåndsoprettede profiler ved første login.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "./db";
import { loadAccessContext } from "../src/auth/context";
import { claimProfile } from "../src/auth/login";
import { registerUser, createClub, createTeam, runImport, getSignupInfo, saveSignupSettings, submitSignup, listSignups, decideSignup, setTeamCapacity } from "../src/services";
import { clubMemberships, guardianships, profiles, signupRequests, teamMembers, teamWaitlist, users } from "../src/db/schema";
import { and, eq, inArray } from "drizzle-orm";

const { db, sql, reset } = testDb();
const now = new Date("2026-11-02T12:00:00Z");
let clubId: string;
let teamId: string;
let admin: Awaited<ReturnType<typeof loadAccessContext>>;
const sent: { to: string; subject: string; text: string }[] = [];
const mail = vi.fn(async (to: string, subject: string, text: string) => {
  sent.push({ to, subject, text });
});
const base = { firstName: "Ida", lastName: "Iversen", birthDate: "14-05-1990", email: "Ida@eks.dk", acceptTerms: true };

beforeAll(async () => {
  await reset();
  const u = await registerUser(db, "formand@ind.test", { firstName: "Fa", lastName: "Mand", birthDate: "1970-01-01" });
  clubId = (await createClub(db, await loadAccessContext(db, u.user.id, now), "Ind IF", "ind-if")).id;
  admin = await loadAccessContext(db, u.user.id, now);
  teamId = (await createTeam(db, admin, clubId, "U9", "2026/27")).id;
});
afterAll(async () => {
  await sql.end();
});

describe("åbent link og indstillinger", () => {
  it("er lukket, indtil admin åbner det, og viser kun hold og betingelser", async () => {
    expect(await getSignupInfo(db, "ind-if")).toBeNull();
    await expect(submitSignup(db, "ind-if", base, mail, "http://x", now)).rejects.toThrow("ikke åbnet");
    await saveSignupSettings(db, admin, clubId, { enabled: true, minAge: 5, maxAge: 60, terms: "Vi tager billeder til hjemmesiden." });
    const info = await getSignupInfo(db, "ind-if");
    expect(info).toMatchObject({ clubName: "Ind IF", minAge: 5, maxAge: 60, terms: "Vi tager billeder til hjemmesiden." });
    expect(info!.teams.map((t) => t.name)).toEqual(["U9"]);
    expect(await getSignupInfo(db, "findes-ikke")).toBeNull();
  });

  it("kræver admin for indstillinger", async () => {
    const other = await registerUser(db, "fremmed@ind.test", { firstName: "Fre", lastName: "Mmed" });
    const ctx = await loadAccessContext(db, other.user.id, now);
    await expect(saveSignupSettings(db, ctx, clubId, { enabled: false, minAge: null, maxAge: null, terms: null })).rejects.toThrow();
    await expect(listSignups(db, ctx, clubId)).rejects.toThrow();
    await expect(saveSignupSettings(db, admin, clubId, { enabled: true, minAge: 10, maxAge: 5, terms: null })).rejects.toThrow("Mindstealderen");
    await saveSignupSettings(db, admin, clubId, { enabled: true, minAge: 5, maxAge: 60, terms: "Vi tager billeder til hjemmesiden." });
  });
});

describe("ansøgning", () => {
  it("afviser ugyldige ansøgninger", async () => {
    const go = (patch: object) => submitSignup(db, "ind-if", { ...base, ...patch }, mail, "http://x", now);
    await expect(go({ birthDate: "31-02-1990" })).rejects.toThrow("Fødselsdatoen");
    await expect(go({ email: "ikke-en-mail" })).rejects.toThrow("e-mail");
    await expect(go({ acceptTerms: false })).rejects.toThrow("acceptere");
    await expect(go({ birthDate: "01-01-2025" })).rejects.toThrow("mindst 5 år");
    await expect(go({ birthDate: "01-01-1940" })).rejects.toThrow("til og med 60");
    await expect(go({ birthDate: "01-01-2015" })).rejects.toThrow("forælder");
    await expect(go({ birthDate: "01-01-2015", guardianName: "Mette" })).rejects.toThrow("for- og efternavn");
    await expect(go({ teamId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow("Holdet findes ikke");
    expect(await db.select().from(signupRequests)).toHaveLength(0);
  });

  it("gemmer ansøgningen med betingelserne, mailer ansøger og admin, men opretter ingen person endnu", async () => {
    sent.length = 0;
    await submitSignup(db, "ind-if", { ...base, teamId, phone: "12345678" }, mail, "http://x", now);
    const [r] = await db.select().from(signupRequests);
    expect(r).toMatchObject({ status: "pending", contactEmail: "ida@eks.dk", termsText: "Vi tager billeder til hjemmesiden.", teamId });
    expect(sent.map((m) => m.to).sort()).toEqual(["formand@ind.test", "ida@eks.dk"]);
    expect(await sql`select 1 from profiles where first_name = 'Ida'`).toHaveLength(0);
    await expect(submitSignup(db, "ind-if", { ...base, teamId }, mail, "http://x", now)).rejects.toThrow("allerede modtaget");
  });

  it("begrænser antal ansøgninger fra samme e-mail", async () => {
    for (const n of ["A", "B"]) await submitSignup(db, "ind-if", { ...base, firstName: `Ida${n}` }, mail, "http://x", now);
    await expect(submitSignup(db, "ind-if", { ...base, firstName: "IdaC" }, mail, "http://x", now)).rejects.toThrow("flere ansøgninger");
    await db.delete(signupRequests).where(inArray(signupRequests.firstName, ["IdaA", "IdaB"]));
  });
});

describe("godkendelse", () => {
  it("opretter medlem og spiller og skriver til ansøgeren, og kan kun behandles én gang", async () => {
    sent.length = 0;
    const [req] = await listSignups(db, admin, clubId);
    expect(req).toMatchObject({ firstName: "Ida", age: 36, minor: false, teamName: "U9" });
    const out = await decideSignup(db, admin, req.id, { approve: true }, mail);
    expect(out).toMatchObject({ status: "approved", placement: "team" });
    const [p] = await db.select().from(profiles).where(eq(profiles.firstName, "Ida"));
    expect(p).toMatchObject({ email: "ida@eks.dk", birthDate: "1990-05-14", phone: "12345678" });
    expect(await db.select().from(clubMemberships).where(and(eq(clubMemberships.clubId, clubId), eq(clubMemberships.profileId, p.id)))).toHaveLength(1);
    expect(await db.select().from(teamMembers).where(eq(teamMembers.profileId, p.id))).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "ida@eks.dk", subject: "Velkommen til Ind IF" });
    await expect(decideSignup(db, admin, req.id, { approve: true }, mail)).rejects.toThrow("allerede behandlet");
    await expect(decideSignup(db, admin, req.id, { approve: false }, mail)).rejects.toThrow("allerede behandlet");
    expect(await listSignups(db, admin, clubId)).toHaveLength(0);
  });

  it("opretter barn og forælder, og barnet kommer på venteliste, når holdet er fuldt", async () => {
    await setTeamCapacity(db, admin, teamId, 1);
    await submitSignup(db, "ind-if", { ...base, firstName: "Liv", lastName: "Larsen", birthDate: "03-04-2018", email: "mor@eks.dk", guardianName: "Mette Larsen", teamId }, mail, "http://x", now);
    const [req] = await listSignups(db, admin, clubId);
    expect(req).toMatchObject({ minor: true, guardianName: "Mette Larsen" });
    const out = await decideSignup(db, admin, req.id, { approve: true }, mail);
    expect(out).toMatchObject({ placement: "waitlist" });
    const [child] = await db.select().from(profiles).where(eq(profiles.firstName, "Liv"));
    expect(child.email).toBeNull();
    const [g] = await db.select().from(guardianships).where(eq(guardianships.childProfileId, child.id));
    const [guardian] = await db.select().from(profiles).where(eq(profiles.id, g.guardianProfileId));
    expect(guardian).toMatchObject({ firstName: "Mette", lastName: "Larsen", email: "mor@eks.dk" });
    expect(await db.select().from(teamWaitlist).where(eq(teamWaitlist.profileId, child.id))).toHaveLength(1);
  });

  it("afviser med besked og mailer ansøgeren; hold fra en anden forening nægtes", async () => {
    sent.length = 0;
    await submitSignup(db, "ind-if", { ...base, firstName: "Nej", lastName: "Nielsen", email: "nej@eks.dk" }, mail, "http://x", now);
    const [req] = await listSignups(db, admin, clubId);
    const u2 = await registerUser(db, "anden@ind.test", { firstName: "An", lastName: "Den", birthDate: "1971-01-01" });
    const c2 = await createClub(db, await loadAccessContext(db, u2.user.id, now), "Anden IF", "anden-if");
    const t2 = await createTeam(db, await loadAccessContext(db, u2.user.id, now), c2.id, "X");
    await expect(decideSignup(db, admin, req.id, { approve: true, teamId: t2.id }, mail)).rejects.toThrow("ikke til foreningen");
    expect(await db.select().from(signupRequests).where(eq(signupRequests.id, req.id))).toMatchObject([{ status: "pending" }]);
    await expect(decideSignup(db, await loadAccessContext(db, u2.user.id, now), req.id, { approve: false }, mail)).rejects.toThrow();
    await decideSignup(db, admin, req.id, { approve: false, note: "Vi har lukket for denne årgang." }, mail);
    expect(sent.filter((m) => m.to === "nej@eks.dk").pop()?.text).toContain("Vi har lukket for denne årgang.");
    expect(await sql`select 1 from profiles where first_name = 'Nej'`).toHaveLength(0);
  });
});

describe("spamgrænser og mails", () => {
  it("begrænser pr. IP og sender højst én admin-mail i timen uden at gentage ansøgerens navn", async () => {
    const t = new Date(now.getTime() + 3 * 86_400_000);
    sent.length = 0;
    for (let i = 0; i < 5; i++) await submitSignup(db, "ind-if", { ...base, firstName: `Ip${i}`, email: `ip${i}@eks.dk` }, mail, "http://x", t, "1.2.3.4");
    await expect(submitSignup(db, "ind-if", { ...base, firstName: "Ip5", email: "ip5@eks.dk" }, mail, "http://x", t, "1.2.3.4")).rejects.toThrow("mange ansøgninger herfra");
    await submitSignup(db, "ind-if", { ...base, firstName: "Ip5", email: "ip5@eks.dk" }, mail, "http://x", t, "5.6.7.8");
    expect(sent.filter((m) => m.to === "formand@ind.test")).toHaveLength(1);
    expect(sent.some((m) => /Ip\d/.test(m.text))).toBe(false);
    await db.delete(signupRequests).where(inArray(signupRequests.firstName, ["Ip0", "Ip1", "Ip2", "Ip3", "Ip4", "Ip5"]));
  });
});

describe("privatliv mellem foreninger og fletning ved login", () => {
  it("genbruger ikke en profil fra en anden forening, men flettes først, når ejeren selv logger ind", async () => {
    const a = await registerUser(db, "formand-a@ind.test", { firstName: "Fa", lastName: "A", birthDate: "1970-01-01" });
    const ctxA = await loadAccessContext(db, a.user.id, now);
    const clubA = await createClub(db, ctxA, "Klub A", "klub-a");
    const vera = await registerUser(db, "vera@eks.dk", { firstName: "Vera", lastName: "Vik", birthDate: "1975-03-03" });
    await db.update(profiles).set({ phone: "11 22 33 44" }).where(eq(profiles.id, vera.profile.id));
    await db.insert(clubMemberships).values({ clubId: clubA.id, profileId: vera.profile.id });
    await saveSignupSettings(db, admin, clubId, { enabled: true, minAge: null, maxAge: null, terms: null });
    await submitSignup(db, "ind-if", { ...base, firstName: "Vera", lastName: "Vik", birthDate: "01-01-1990", email: "vera@eks.dk" }, mail, "http://x", now);
    const [req] = await listSignups(db, admin, clubId);
    await decideSignup(db, admin, req.id, { approve: true }, mail);
    const veras = await db.select().from(profiles).where(eq(profiles.firstName, "Vera"));
    expect(veras).toHaveLength(2);
    const fresh = veras.find((p) => p.userId === null)!;
    expect(fresh).toMatchObject({ birthDate: "1990-01-01", phone: null });
    // Først når Vera selv bekræfter e-mailen, flettes de.
    await claimProfile(db, vera.user.id, "vera@eks.dk");
    const after = await db.select().from(profiles).where(eq(profiles.firstName, "Vera"));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: vera.profile.id, birthDate: "1975-03-03", phone: "11 22 33 44" });
    const memberships = await db.select().from(clubMemberships).where(eq(clubMemberships.profileId, vera.profile.id));
    expect(memberships.map((m) => m.clubId).sort()).toEqual([clubA.id, clubId].sort());
  });

  it("samler en forælders børn fra to foreninger, også når efternavnet afviger, men ikke for en anden med samme e-mail", async () => {
    const mona = await registerUser(db, "mona@eks.dk", { firstName: "Mona", lastName: "Mor", birthDate: "1980-01-01" });
    const monaCtx = await loadAccessContext(db, mona.user.id, now);
    const [kid1] = await db.insert(profiles).values({ firstName: "Kid", lastName: "Et", birthDate: "2016-01-01" }).returning();
    await db.insert(guardianships).values({ guardianProfileId: mona.profile.id, childProfileId: kid1.id });
    const file = "Fornavn;Efternavn;Fødselsdato;Forælder;Forælder e-mail\nKid;To;02-02-2017;Mona Mor-Hansen;mona@eks.dk\nKid;Tre;03-03-2018;Per Pedersen;mona@eks.dk";
    await runImport(db, admin, clubId, file, null, true);
    expect((await loadAccessContext(db, mona.user.id, now)).wards.size).toBe(1);
    await claimProfile(db, mona.user.id, "mona@eks.dk");
    const wards = (await loadAccessContext(db, mona.user.id, now)).wards;
    const names = (await db.select().from(profiles).where(inArray(profiles.id, [...wards]))).map((p) => p.lastName).sort();
    // Barn To (Mona Mor-Hansen) kommer med; Barn Tre hører til Per, som kun deler e-mail, og forbliver hos ham.
    expect(names).toEqual(["Et", "To"]);
    void monaCtx;
  });
});

describe("overtagelse af forhåndsoprettet profil ved første login", () => {
  async function login(email: string) {
    const [u] = await db.insert(users).values({ email }).returning();
    await claimProfile(db, u.id, email);
    return u.id;
  }
  it("forælderen overtager sin profil og får barnet med, men barnet overtages aldrig", async () => {
    const uid = await login("mor@eks.dk");
    const [mine] = await db.select().from(profiles).where(eq(profiles.userId, uid));
    expect(mine).toMatchObject({ firstName: "Mette", lastName: "Larsen" });
    const ctx = await loadAccessContext(db, uid, now);
    const [child] = await db.select().from(profiles).where(eq(profiles.firstName, "Liv"));
    expect(ctx.wards).toContain(child.id);
    expect(child.userId).toBeNull();
  });
  it("den voksne ansøger overtager sin profil", async () => {
    const uid = await login("ida@eks.dk");
    const [mine] = await db.select().from(profiles).where(eq(profiles.userId, uid));
    expect(mine.firstName).toBe("Ida");
  });
  it("overtager hverken børn eller profiler uden fødselsdato, der ikke er værger", async () => {
    await db.insert(profiles).values({ firstName: "Barn", lastName: "Uden", email: "delt@eks.dk" });
    await db.insert(profiles).values({ firstName: "Lille", lastName: "Mig", birthDate: "2018-01-01", email: "delt@eks.dk" });
    const uid = await login("delt@eks.dk");
    expect(await db.select().from(profiles).where(eq(profiles.userId, uid))).toHaveLength(0);
  });
});
