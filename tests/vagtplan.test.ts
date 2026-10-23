// Vagtplan, kontrakter og børneattester.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { loadAccessContext } from "../src/auth/context";
import {
  registerUser, createClub, createTeam, addTeamMember, createChildProfile,
  createShift, updateShift, cancelShift, signUpForShift, cancelShiftSignup, listShifts, sendShiftReminders,
  createContract, updateContract, deleteDraftContract, sendContract, signContract, declineContract, cancelContract, listClubContracts, listMyContracts, sendContractReminders, contractTemplate, hasActiveContract,
  requireCertificate, giveCertificateConsent, recordWrittenConsent, markCertificateRequested, registerCertificateResult, removeCertificate, hasValidCertificate,
  listClubCertificates, listCertificateGaps, listMyCertificates, sendCertificateReminders, certificateState,
  exportMyData, deleteMyAccount,
} from "../src/services";
import { childCertificates, clubMemberships, contracts, guardianships, shiftSignups } from "../src/db/schema";
import { withUserScope } from "../src/db/scope";
import { parseLocalDateTime } from "../src/lib/time";

const { db, sql, reset } = testDb();
const now = new Date("2026-06-01T10:00:00Z");
const sent: { to: string; subject: string }[] = [];
const deliver = { mail: async (to: string, subject: string) => void sent.push({ to, subject }), sms: null, baseUrl: "https://x.test" };
let clubId: string;
let teamId: string;
let admin: Awaited<ReturnType<typeof loadAccessContext>>;
let coach: Awaited<ReturnType<typeof loadAccessContext>>;
let coachProfile: string;

const ctxOf = async (userId: string, at = now) => loadAccessContext(db, userId, at);
async function member(email: string, first: string, birth = "1985-01-01") {
  const u = await registerUser(db, email, { firstName: first, lastName: "Test", birthDate: birth });
  await db.insert(clubMemberships).values({ clubId, profileId: u.profile.id });
  return { ...u, ctx: await ctxOf(u.user.id) };
}
const at = (d: string, h: number, m = 0) => parseLocalDateTime(`2026-06-${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
const shift = (over: Partial<Parameters<typeof createShift>[3]> = {}) => createShift(db, admin, clubId, { title: "Kiosk", startsAt: at("10", 10), endsAt: at("10", 12), slots: 2, ...over });

beforeAll(async () => {
  await reset();
  const a = await registerUser(db, "admin@vagt.test", { firstName: "Ad", lastName: "Min", birthDate: "1970-01-01" });
  clubId = (await createClub(db, await ctxOf(a.user.id), "Vagt IF", "vagt-if")).id;
  admin = await ctxOf(a.user.id);
  teamId = (await createTeam(db, admin, clubId, "U9", "2026")).id;
  const c = await member("coach@vagt.test", "Carla");
  await addTeamMember(db, admin, teamId, c.profile.id, "coach");
  coach = await ctxOf(c.user.id);
  coachProfile = c.profile.id;
});
afterAll(async () => {
  await sql.end();
});

describe("vagtplan", () => {
  it("admin og holdets træner opretter vagter, andre ikke, og værdierne tjekkes", async () => {
    const m = await member("m0@vagt.test", "Mia");
    await expect(createShift(db, m.ctx, clubId, { title: "X", startsAt: at("10", 10), endsAt: at("10", 11) })).rejects.toThrow();
    await expect(createShift(db, coach, clubId, { title: "X", startsAt: at("10", 10), endsAt: at("10", 11) })).rejects.toThrow();
    await expect(shift({ title: " " })).rejects.toThrow("titel");
    await expect(shift({ slots: 0 })).rejects.toThrow("pladser");
    await expect(shift({ endsAt: at("10", 10, 5) })).rejects.toThrow("15 minutter");
    await expect(shift({ startsAt: at("10", 10), endsAt: at("11", 10) })).rejects.toThrow("timer");
    await expect(shift({ startsAt: parseLocalDateTime("2026-05-01T10:00"), endsAt: parseLocalDateTime("2026-05-01T11:00") })).rejects.toThrow("fortiden");
    const own = await createShift(db, coach, clubId, { title: "Kridtning", startsAt: at("12", 9), endsAt: at("12", 10), teamId });
    expect(own.teamId).toBe(teamId);
    const other = await createTeam(db, admin, clubId, "U11", "2026");
    await expect(createShift(db, coach, clubId, { title: "X", startsAt: at("12", 9), endsAt: at("12", 10), teamId: other.id })).rejects.toThrow();
  });

  it("pladser er først til mølle, og man kan ikke tage to vagter på samme tid", async () => {
    const s = await shift({ title: "Grill", slots: 1, startsAt: at("14", 10), endsAt: at("14", 12) });
    const a = await member("a1@vagt.test", "Anne");
    const b = await member("b1@vagt.test", "Bo");
    await signUpForShift(db, a.ctx, s.id);
    await expect(signUpForShift(db, a.ctx, s.id)).rejects.toThrow("allerede");
    await expect(signUpForShift(db, b.ctx, s.id)).rejects.toThrow("fuld");
    const s2 = await shift({ title: "Kaffe", slots: 3, startsAt: at("14", 11), endsAt: at("14", 13) });
    await expect(signUpForShift(db, a.ctx, s2.id)).rejects.toThrow("samme tidsrum");
    const s3 = await shift({ title: "Oprydning", slots: 3, startsAt: at("14", 12), endsAt: at("14", 13) });
    await signUpForShift(db, a.ctx, s3.id);
  });

  it("to samtidige tilmeldinger tager ikke den sidste plads", async () => {
    const s = await shift({ title: "Kapløb", slots: 1, startsAt: at("15", 10), endsAt: at("15", 11) });
    const ps = await Promise.all([1, 2, 3].map((i) => member(`race${i}@vagt.test`, `R${i}`)));
    const results = await Promise.allSettled(ps.map((p) => signUpForShift(db, p.ctx, s.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("kun aktive medlemmer, mindst 15 år, og forældre kan tage vagter for børn", async () => {
    const s = await shift({ title: "Børnefest", slots: 5, startsAt: at("16", 10), endsAt: at("16", 12) });
    const outsider = await registerUser(db, "ude@vagt.test", { firstName: "Ude", lastName: "Test", birthDate: "1985-01-01" });
    await expect(signUpForShift(db, await ctxOf(outsider.user.id), s.id)).rejects.toThrow("medlemmer");
    const parent = await member("far@vagt.test", "Far");
    const teen = await createChildProfile(db, parent.ctx, { firstName: "Teen", lastName: "Test", birthDate: "2011-01-01" });
    const kid = await createChildProfile(db, parent.ctx, { firstName: "Lille", lastName: "Test", birthDate: "2018-01-01" });
    await db.insert(clubMemberships).values([{ clubId, profileId: teen.id }, { clubId, profileId: kid.id }]);
    const pctx = await ctxOf(parent.user.id);
    await expect(signUpForShift(db, pctx, s.id, kid.id)).rejects.toThrow("mindst 15");
    await signUpForShift(db, pctx, s.id, teen.id);
    // en fremmed forælder kan ikke tage vagten for andres barn
    const stranger = await member("fremmed@vagt.test", "Fremmed");
    await expect(signUpForShift(db, stranger.ctx, s.id, teen.id)).rejects.toThrow();
    const listed = (await listShifts(db, pctx)).find((x) => x.id === s.id)!;
    expect(listed.volunteers.map((v) => v.name)).toEqual(["Teen"]);
    expect(listed.volunteers[0].mine).toBe(true);
    // medlemmer ser fornavne, admin ser fulde navne
    expect((await listShifts(db, admin)).find((x) => x.id === s.id)!.volunteers[0].name).toBe("Teen Test");
  });

  it("afmelding: selv før vagten, ikke efter; admin altid. Aflysning giver besked", async () => {
    const s = await shift({ title: "Aflysning", slots: 2, startsAt: at("17", 10), endsAt: at("17", 12) });
    const a = await member("c1@vagt.test", "Cathrine");
    const b = await member("d1@vagt.test", "Dan");
    await signUpForShift(db, a.ctx, s.id);
    await signUpForShift(db, b.ctx, s.id);
    await expect(cancelShiftSignup(db, b.ctx, s.id, a.profile.id)).rejects.toThrow();
    await cancelShiftSignup(db, a.ctx, s.id, a.profile.id);
    await expect(cancelShiftSignup(db, a.ctx, s.id, a.profile.id)).rejects.toThrow("ingen tilmelding");
    // pladsen er fri igen, og man kan tage den på ny
    await signUpForShift(db, a.ctx, s.id);
    const late = await ctxOf(b.user.id, at("17", 10, 30));
    await expect(cancelShiftSignup(db, late, s.id, b.profile.id)).rejects.toThrow("begyndt");
    await cancelShiftSignup(db, await ctxOf(admin.userId, at("17", 10, 30)), s.id, b.profile.id);
    sent.length = 0;
    await cancelShift(db, admin, s.id, deliver);
    expect(sent.map((m) => m.to)).toEqual(["c1@vagt.test"]);
    await expect(cancelShift(db, admin, s.id)).rejects.toThrow("allerede");
    await expect(signUpForShift(db, b.ctx, s.id)).rejects.toThrow("aflyst");
  });

  it("antal pladser kan ikke sættes under antal tilmeldte", async () => {
    const s = await shift({ title: "Rettelse", slots: 3, startsAt: at("18", 10), endsAt: at("18", 12) });
    const a = await member("e1@vagt.test", "Ea");
    const b = await member("f1@vagt.test", "Finn");
    await signUpForShift(db, a.ctx, s.id);
    await signUpForShift(db, b.ctx, s.id);
    await expect(updateShift(db, admin, s.id, { title: "Rettelse", startsAt: s.startsAt, endsAt: s.endsAt, slots: 1 })).rejects.toThrow("tilmeldt");
    await updateShift(db, admin, s.id, { title: "Rettelse 2", startsAt: s.startsAt, endsAt: s.endsAt, slots: 2 });
  });

  it("påmindelse sendes én gang, dagen før vagten", async () => {
    const s = await shift({ title: "Påmind", slots: 2, startsAt: at("20", 10), endsAt: at("20", 12) });
    const a = await member("g1@vagt.test", "Gry");
    await signUpForShift(db, a.ctx, s.id);
    sent.length = 0;
    const mine = () => sent.filter((m) => m.to === "g1@vagt.test").length;
    await sendShiftReminders(db, deliver, at("18", 9));
    expect(mine()).toBe(0);
    await sendShiftReminders(db, deliver, at("19", 11));
    expect(mine()).toBe(1);
    await sendShiftReminders(db, deliver, at("19", 12));
    expect(mine()).toBe(1);
  });
});

describe("børneattester", () => {
  it("forløb: kræv, samtykke, bestilling, svar. Bestilling kræver samtykke", async () => {
    const p = await member("att1@vagt.test", "Atte");
    const id = await requireCertificate(db, admin, clubId, p.profile.id, "Træner U9");
    await expect(requireCertificate(db, admin, clubId, p.profile.id)).rejects.toThrow("i gang");
    await expect(markCertificateRequested(db, admin, id)).rejects.toThrow("samtykke");
    await expect(giveCertificateConsent(db, coach, id)).rejects.toThrow();
    await giveCertificateConsent(db, p.ctx, id);
    await expect(giveCertificateConsent(db, p.ctx, id)).rejects.toThrow("allerede");
    await expect(registerCertificateResult(db, admin, id, { approved: true, issuedOn: "2026-05-30", expiresOn: "2029-05-30" })).rejects.toThrow("bestilt");
    await markCertificateRequested(db, admin, id);
    await expect(registerCertificateResult(db, admin, id, { approved: true, issuedOn: "2026-05-30" })).rejects.toThrow("ny attest");
    await expect(registerCertificateResult(db, admin, id, { approved: true, issuedOn: "2026-07-30", expiresOn: "2029-05-30" })).rejects.toThrow("fremtiden");
    await expect(registerCertificateResult(db, admin, id, { approved: true, issuedOn: "2026-05-30", expiresOn: "2026-05-01" })).rejects.toThrow("efter");
    await registerCertificateResult(db, admin, id, { approved: true, issuedOn: "2026-05-30", expiresOn: "2029-05-30" });
    expect(await hasValidCertificate(db, clubId, p.profile.id, now)).toBe(true);
    expect(await hasValidCertificate(db, clubId, p.profile.id, parseLocalDateTime("2029-06-01T10:00"))).toBe(false);
    await expect(requireCertificate(db, admin, clubId, p.profile.id)).rejects.toThrow("gyldig");
    expect((await listClubCertificates(db, admin, clubId)).find((c) => c.id === id)!.state).toBe("valid");
  });

  it("kun admin ser listen, men man ser egen status; ikke-godkendt giver ingen vagtadgang", async () => {
    const p = await member("att2@vagt.test", "Bent");
    const id = await requireCertificate(db, admin, clubId, p.profile.id);
    await expect(listClubCertificates(db, coach, clubId)).rejects.toThrow();
    await expect(requireCertificate(db, coach.userId ? coach : admin, clubId, "00000000-0000-0000-0000-000000000000")).rejects.toThrow();
    expect((await listMyCertificates(db, p.ctx))[0]).toMatchObject({ state: "no_consent", canConsent: true });
    await recordWrittenConsent(db, admin, id);
    await expect(recordWrittenConsent(db, admin, id)).rejects.toThrow("allerede");
    await markCertificateRequested(db, admin, id);
    await registerCertificateResult(db, admin, id, { approved: false });
    expect(await hasValidCertificate(db, clubId, p.profile.id, now)).toBe(false);
    expect((await listMyCertificates(db, p.ctx))[0].state).toBe("not_approved");
    // nyt forløb nulstiller samtykket
    await requireCertificate(db, admin, clubId, p.profile.id);
    const [row] = await db.select().from(childCertificates).where(eq(childCertificates.id, id));
    expect(row).toMatchObject({ status: "needed", consentAt: null, expiresOn: null });
  });

  it("er personen under 18 år, er det værgen, der giver samtykke", async () => {
    const parent = await member("att3@vagt.test", "Mor");
    const teen = await createChildProfile(db, parent.ctx, { firstName: "Ung", lastName: "Test", birthDate: "2010-01-01" });
    await db.insert(clubMemberships).values({ clubId, profileId: teen.id });
    const id = await requireCertificate(db, admin, clubId, teen.id);
    const other = await member("att4@vagt.test", "Anden");
    await expect(giveCertificateConsent(db, other.ctx, id)).rejects.toThrow();
    const pctx = await ctxOf(parent.user.id);
    expect((await listMyCertificates(db, pctx)).find((c) => c.id === id)!.canConsent).toBe(true);
    await giveCertificateConsent(db, pctx, id);
  });

  it("tilstande og overblik: udløb, snart-udløb og huller", async () => {
    expect(certificateState({ status: "approved", consentAt: now, expiresOn: "2026-06-01" }, "2026-06-01")).toBe("expired");
    expect(certificateState({ status: "approved", consentAt: now, expiresOn: "2026-07-15" }, "2026-06-01")).toBe("expiring");
    expect(certificateState({ status: "approved", consentAt: now, expiresOn: "2027-06-01" }, "2026-06-01")).toBe("valid");
    // Carla er træner og har ingen attest: hun står i hullerne
    let gaps = await listCertificateGaps(db, admin, clubId);
    expect(gaps.find((g) => g.profileId === coachProfile)!.reason).toContain("Træner U9");
    await requireCertificate(db, admin, clubId, coachProfile, "Træner U9");
    gaps = await listCertificateGaps(db, admin, clubId);
    expect(gaps.some((g) => g.profileId === coachProfile)).toBe(false);
    await expect(listCertificateGaps(db, coach, clubId)).rejects.toThrow();
  });

  it("vagter med børn kræver en gyldig attest", async () => {
    const s = await shift({ title: "Børnevagt", slots: 3, requiresChildCertificate: true, startsAt: at("22", 10), endsAt: at("22", 12) });
    const p = await member("att5@vagt.test", "Cecil");
    await expect(signUpForShift(db, p.ctx, s.id)).rejects.toThrow("børneattest");
    const id = await requireCertificate(db, admin, clubId, p.profile.id);
    await recordWrittenConsent(db, admin, id);
    await markCertificateRequested(db, admin, id);
    // en attest, der udløber før vagten, tæller ikke
    await registerCertificateResult(db, admin, id, { approved: true, issuedOn: "2026-05-01", expiresOn: "2026-06-10" });
    await expect(signUpForShift(db, p.ctx, s.id)).rejects.toThrow("børneattest");
    const later = await shift({ title: "Børnevagt 2", requiresChildCertificate: true, startsAt: at("05", 10), endsAt: at("05", 12) });
    await signUpForShift(db, p.ctx, later.id);
    const opt = (await listShifts(db, p.ctx)).find((x) => x.id === s.id)!.options[0];
    expect(opt.missingCertificate).toBe(true);
    // personen står som hul på vagten
    const lapsed = await member("att6@vagt.test", "Dorte");
    const row = await requireCertificate(db, admin, clubId, lapsed.profile.id);
    await recordWrittenConsent(db, admin, row);
    await markCertificateRequested(db, admin, row);
    await registerCertificateResult(db, admin, row, { approved: true, issuedOn: "2020-01-01", expiresOn: "2023-01-01" });
    await removeCertificate(db, admin, row);
    expect((await listClubCertificates(db, admin, clubId)).some((c) => c.id === row)).toBe(false);
  });

  it("påmindelser: samtykke til personen, udløb og forsinkelser til admin, højst én gang om ugen", async () => {
    const p = await member("att7@vagt.test", "Emil");
    await requireCertificate(db, admin, clubId, p.profile.id);
    const q = await member("att8@vagt.test", "Fie");
    const qid = await requireCertificate(db, admin, clubId, q.profile.id);
    await recordWrittenConsent(db, admin, qid);
    await markCertificateRequested(db, admin, qid);
    await registerCertificateResult(db, admin, qid, { approved: true, issuedOn: "2026-05-01", expiresOn: "2026-07-01" });
    // Rækkerne oprettes med databasens ur, så "senere" regnes fra det rigtige nu.
    const later = new Date(Date.now() + 20 * 86400000);
    sent.length = 0;
    const r1 = await sendCertificateReminders(db, deliver, later);
    expect(r1.personal).toBeGreaterThanOrEqual(1);
    expect(r1.admins).toBe(1);
    expect(sent.some((m) => m.to === "att7@vagt.test")).toBe(true);
    expect(sent.some((m) => m.to === "admin@vagt.test" && m.subject.includes("Børneattester"))).toBe(true);
    const r2 = await sendCertificateReminders(db, deliver, later);
    expect(r2).toEqual({ personal: 0, admins: 0 });
  });

  it("en forening kan ikke se en andens attester (RLS)", async () => {
    const o = await registerUser(db, "anden@vagt.test", { firstName: "Os", lastName: "Test", birthDate: "1980-01-01" });
    const otherClub = await createClub(db, await ctxOf(o.user.id), "Anden IF", "anden-vagt");
    const octx = await ctxOf(o.user.id);
    await withUserScope(db, o.user.id, async (tx) => {
      expect(await tx.select().from(childCertificates)).toEqual([]);
      expect(await tx.select().from(contracts)).toEqual([]);
      expect(await tx.select().from(shiftSignups)).toEqual([]);
    });
    await expect(listClubCertificates(db, octx, clubId)).rejects.toThrow();
    expect(otherClub.id).not.toBe(clubId);
  });
});

describe("kontrakter", () => {
  const base = (profileId: string, over: Partial<Parameters<typeof createContract>[3]> = {}) => ({
    profileId, kind: "coach" as const, title: "Trænerkontrakt U9", body: contractTemplate("coach"), startsOn: "2026-07-01", endsOn: "2027-06-30", monthlyAmountOre: 150_000, ...over,
  });

  it("kun admin opretter; teksten og felterne tjekkes; skabelonen har ingen beløb", async () => {
    const p = await member("k1@vagt.test", "Kris");
    await expect(createContract(db, coach, clubId, base(p.profile.id))).rejects.toThrow();
    await expect(createContract(db, admin, clubId, base(p.profile.id, { title: " " }))).rejects.toThrow("titel");
    await expect(createContract(db, admin, clubId, base(p.profile.id, { body: "" }))).rejects.toThrow("tekst");
    await expect(createContract(db, admin, clubId, base(p.profile.id, { endsOn: "2026-01-01" }))).rejects.toThrow("Slutdatoen");
    await expect(createContract(db, admin, clubId, base(p.profile.id, { monthlyAmountOre: 20_000_000 }))).rejects.toThrow("Beløbet");
    const out = await registerUser(db, "ude2@vagt.test", { firstName: "Ude", lastName: "Test", birthDate: "1985-01-01" });
    await expect(createContract(db, admin, clubId, base(out.profile.id))).rejects.toThrow("foreningen");
    expect(contractTemplate("coach")).not.toMatch(/\d+\s*kr/i);
  });

  it("kladde kan rettes og slettes; afsendelse låser teksten", async () => {
    const p = await member("k2@vagt.test", "Lone");
    const c = await createContract(db, admin, clubId, base(p.profile.id));
    expect((await listMyContracts(db, p.ctx)).length).toBe(0); // kladder ses ikke
    await updateContract(db, admin, c.id, { kind: "coach", title: "Ny titel", body: "Ny tekst", startsOn: "2026-07-01" });
    await sendContract(db, admin, c.id, deliver);
    await expect(updateContract(db, admin, c.id, { kind: "coach", title: "X", body: "Y", startsOn: "2026-07-01" })).rejects.toThrow("kladde");
    await expect(deleteDraftContract(db, admin, c.id)).rejects.toThrow("kladde");
    await expect(sendContract(db, admin, c.id)).rejects.toThrow("allerede");
    const d = await createContract(db, admin, clubId, base(p.profile.id));
    await deleteDraftContract(db, admin, d.id);
  });

  it("underskrift kræver det rigtige navn og rigtig person; tekstændring efter afsendelse afvises", async () => {
    const p = await member("k3@vagt.test", "Mads");
    const stranger = await member("k3b@vagt.test", "Nina");
    const c = await createContract(db, admin, clubId, base(p.profile.id));
    await expect(signContract(db, p.ctx, c.id, "Mads Test")).rejects.toThrow("underskrives");
    sent.length = 0;
    await sendContract(db, admin, c.id, deliver);
    expect(sent.map((m) => m.to)).toContain("k3@vagt.test");
    await expect(signContract(db, stranger.ctx, c.id, "Nina Test")).rejects.toThrow();
    await expect(signContract(db, admin, c.id, "Ad Min")).rejects.toThrow();
    await expect(signContract(db, p.ctx, c.id, "Mads Madsen")).rejects.toThrow("fulde navn");
    // manipuleret tekst
    await db.update(contracts).set({ body: "Snydt" }).where(eq(contracts.id, c.id));
    await expect(signContract(db, p.ctx, c.id, "Mads Test")).rejects.toThrow("ændret");
    await db.update(contracts).set({ body: c.body }).where(eq(contracts.id, c.id));
    await signContract(db, p.ctx, c.id, " mads  test ");
    await expect(signContract(db, p.ctx, c.id, "Mads Test")).rejects.toThrow("allerede");
    const [row] = await db.select().from(contracts).where(eq(contracts.id, c.id));
    expect(row).toMatchObject({ status: "signed", signedName: "Mads Test", signedByUserId: p.user.id });
    expect(await hasActiveContract(db, clubId, p.profile.id, "coach", at("10", 10))).toBe(false); // starter 1. juli
    expect(await hasActiveContract(db, clubId, p.profile.id, "coach", parseLocalDateTime("2026-07-02T10:00"))).toBe(true);
    await cancelContract(db, admin, c.id);
    await expect(cancelContract(db, admin, c.id)).rejects.toThrow("tilbage");
    expect(await hasActiveContract(db, clubId, p.profile.id, "coach", parseLocalDateTime("2026-07-02T10:00"))).toBe(false);
  });

  it("for et barn under 18 skriver en værge under, ikke barnet selv", async () => {
    const parent = await member("k4@vagt.test", "Poul");
    const teen = await createChildProfile(db, parent.ctx, { firstName: "Ida", lastName: "Test", birthDate: "2010-03-03" });
    await db.insert(clubMemberships).values({ clubId, profileId: teen.id });
    const c = await createContract(db, admin, clubId, base(teen.id, { kind: "player", title: "Spillerkontrakt", monthlyAmountOre: null }));
    await sendContract(db, admin, c.id);
    const pctx = await ctxOf(parent.user.id);
    const mine = (await listMyContracts(db, pctx)).find((x) => x.id === c.id)!;
    expect(mine.canSign).toBe(true);
    await expect(signContract(db, pctx, c.id, "Ida Test")).rejects.toThrow("fulde navn");
    await signContract(db, pctx, c.id, "Poul Test");
    const [row] = await db.select().from(contracts).where(eq(contracts.id, c.id));
    expect(row.signedName).toBe("Poul Test");
  });

  it("modtageren kan afvise", async () => {
    const p = await member("k5@vagt.test", "Rune");
    const c = await createContract(db, admin, clubId, base(p.profile.id));
    await sendContract(db, admin, c.id);
    await expect(declineContract(db, coach, c.id)).rejects.toThrow();
    await declineContract(db, p.ctx, c.id, "Vil ikke");
    expect((await listMyContracts(db, p.ctx))[0]).toMatchObject({ status: "declined", canSign: false });
  });

  it("påmindelser: ikke underskrevet efter en uge, og udløb inden 30 dage, hver kun én gang", async () => {
    const p = await member("k6@vagt.test", "Sara");
    const c = await createContract(db, admin, clubId, base(p.profile.id, { startsOn: "2026-06-01", endsOn: "2026-08-15" }));
    await sendContract(db, admin, c.id);
    sent.length = 0;
    expect((await sendContractReminders(db, deliver, new Date(now.getTime() + 3 * 86400000))).remindersSent).toBe(0);
    const week = new Date(now.getTime() + 8 * 86400000);
    expect((await sendContractReminders(db, deliver, week)).remindersSent).toBeGreaterThanOrEqual(1);
    expect((await sendContractReminders(db, deliver, week)).remindersSent).toBe(0);
    expect(sent.filter((m) => m.to === "k6@vagt.test")).toHaveLength(1);
    await signContract(db, await ctxOf(p.user.id, week), c.id, "Sara Test");
    expect((await sendContractReminders(db, deliver, new Date("2026-07-01T10:00:00Z"))).noticesSent).toBe(0);
    sent.length = 0;
    const nearEnd = new Date("2026-07-25T10:00:00Z");
    expect((await sendContractReminders(db, deliver, nearEnd)).noticesSent).toBe(1);
    expect(sent.filter((m) => m.subject.startsWith("Kontrakt udløber")).map((m) => m.to)).toEqual(["admin@vagt.test"]);
    expect((await sendContractReminders(db, deliver, nearEnd)).noticesSent).toBe(0);
    const row = (await listClubContracts(db, await ctxOf(admin.userId, nearEnd), clubId)).find((x) => x.id === c.id)!;
    expect(row.expiresSoon).toBe(true);
  });
});

describe("gdpr", () => {
  it("udtræk indeholder vagter, kontrakter og attester, og sletning fjerner dem", async () => {
    const p = await member("gdpr@vagt.test", "Gitte");
    const s = await shift({ title: "GDPR-vagt", startsAt: at("25", 10), endsAt: at("25", 12) });
    await signUpForShift(db, p.ctx, s.id);
    const c = await createContract(db, admin, clubId, { profileId: p.profile.id, kind: "volunteer", title: "Aftale", body: "Tekst", startsOn: "2026-06-01" });
    await sendContract(db, admin, c.id);
    await requireCertificate(db, admin, clubId, p.profile.id);
    const data = (await exportMyData(db, p.ctx)) as unknown as { people: { volunteerShifts: unknown[]; contracts: unknown[]; childCertificates: unknown[] }[] };
    expect(data.people[0].volunteerShifts).toHaveLength(1);
    expect(data.people[0].contracts).toHaveLength(1);
    expect(data.people[0].childCertificates).toHaveLength(1);
    await deleteMyAccount(db, p.ctx, "gdpr@vagt.test");
    expect(await db.select().from(shiftSignups).where(eq(shiftSignups.profileId, p.profile.id))).toEqual([]);
    expect(await db.select().from(contracts).where(eq(contracts.profileId, p.profile.id))).toEqual([]);
    expect(await db.select().from(childCertificates).where(eq(childCertificates.profileId, p.profile.id))).toEqual([]);
    void guardianships;
  });
});
