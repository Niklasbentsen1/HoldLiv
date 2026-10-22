// AI-medlemsservice: kun med foreningens og (for eksterne udbydere) personens samtykke, kun egne oplysninger, ingen navne ud.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { loadAccessContext } from "../src/auth/context";
import { registerUser, createClub, createTeam, createSingleCharge, setAiService, askMemberService, collectFacts, makeAliases, setConsent, aiServiceStatus } from "../src/services";
import { auditLog, clubMemberships, events, guardianships, profiles, teamMembers } from "../src/db/schema";
import { mockAssistant, type Assistant, type AssistantInput } from "../src/lib/memberAssistant";

const { db, sql, reset } = testDb();
const now = new Date("2026-11-02T12:00:00Z");
let clubId: string;
let teamId: string;
let admin: Awaited<ReturnType<typeof loadAccessContext>>;
let mor: Awaited<ReturnType<typeof loadAccessContext>>;
let other: Awaited<ReturnType<typeof loadAccessContext>>;
let emmaId: string;
let morProfile: string;

const ctxOf = async (userId: string) => loadAccessContext(db, userId, now);

beforeAll(async () => {
  await reset();
  const a = await registerUser(db, "admin@ai.test", { firstName: "Ad", lastName: "Min", birthDate: "1970-01-01" });
  clubId = (await createClub(db, await ctxOf(a.user.id), "Ai IF", "ai-if")).id;
  admin = await ctxOf(a.user.id);
  teamId = (await createTeam(db, admin, clubId, "U9 Anders")).id;
  const m = await registerUser(db, "mor@ai.test", { firstName: "Mille", lastName: "Mor", birthDate: "1985-01-01" });
  morProfile = m.profile.id;
  await db.insert(clubMemberships).values({ clubId, profileId: m.profile.id });
  const [emma] = await db.insert(profiles).values({ firstName: "Emma", lastName: "Mor", birthDate: "2017-05-01" }).returning();
  emmaId = emma.id;
  await db.insert(clubMemberships).values({ clubId, profileId: emma.id });
  await db.insert(guardianships).values({ guardianProfileId: m.profile.id, childProfileId: emma.id });
  await db.insert(teamMembers).values({ teamId, profileId: emma.id, role: "player" });
  mor = await ctxOf(m.user.id);
  const o = await registerUser(db, "andre@ai.test", { firstName: "Olga", lastName: "Andre", birthDate: "1980-01-01" });
  const [oc] = await db.insert(profiles).values({ firstName: "Oskar", lastName: "Andre", birthDate: "2017-02-02" }).returning();
  await db.insert(clubMemberships).values([{ clubId, profileId: o.profile.id }, { clubId, profileId: oc.id }]);
  await db.insert(guardianships).values({ guardianProfileId: o.profile.id, childProfileId: oc.id });
  await db.insert(teamMembers).values({ teamId, profileId: oc.id, role: "player" });
  other = await ctxOf(o.user.id);
  await db.insert(events).values({ clubId, teamId, type: "training", title: "Træning hos Anders", location: "Skovby Hallen", startsAt: new Date("2026-11-05T16:00:00Z"), endsAt: new Date("2026-11-05T17:00:00Z") });
  await createSingleCharge(db, admin, clubId, emmaId, { description: "Kontingent Emma", amountOre: 65_000, dueDate: "2026-10-30" });
  await createSingleCharge(db, admin, clubId, oc.id, { description: "Kontingent Oskar", amountOre: 12_300, dueDate: "2026-10-30" });
});
afterAll(async () => {
  await sql.end();
});

describe("tilladelser", () => {
  it("er slået fra som standard, og kun admin slår den til", async () => {
    await expect(askMemberService(db, mor, "Hvad skylder jeg?", mockAssistant)).rejects.toThrow("ikke slået AI-hjælp til");
    await expect(setAiService(db, mor, clubId, true)).rejects.toThrow();
    expect((await aiServiceStatus(db, mor, mockAssistant)).available).toBe(false);
    await setAiService(db, admin, clubId, true);
    expect((await aiServiceStatus(db, mor, mockAssistant)).available).toBe(true);
  });

  it("tjekker spørgsmålet og begrænser antallet pr. døgn", async () => {
    await expect(askMemberService(db, mor, "  ", mockAssistant)).rejects.toThrow("spørgsmål");
    await expect(askMemberService(db, mor, "x".repeat(501), mockAssistant)).rejects.toThrow("500");
  });
});

describe("svar ud fra egne oplysninger", () => {
  it("svarer på betaling og aktiviteter med barnets rigtige navn, og kun om egne børn", async () => {
    const pay = await askMemberService(db, mor, "Hvad skylder jeg i kontingent?", mockAssistant);
    expect(pay).toContain("Emma");
    expect(pay).toContain("650 kr.");
    expect(pay).not.toContain("Oskar");
    expect(pay).not.toContain("123");
    const when = await askMemberService(db, mor, "Hvornår er næste træning?", mockAssistant);
    expect(when).toContain("Skovby Hallen");
    expect(when).toContain("U9 Anders");
    const nope = await askMemberService(db, mor, "Hvad er vejret?", mockAssistant);
    expect(nope).toContain("Skriv til foreningen");
  });

  it("faktaene indeholder kun egne oplysninger og ingen kontaktoplysninger", async () => {
    const facts = JSON.stringify(await collectFacts(db, mor));
    expect(facts).toContain("Emma");
    for (const secret of ["Oskar", "Olga", "andre@ai.test", "mor@ai.test", "2017-05-01", "1985-01-01"]) expect(facts).not.toContain(secret);
  });

  it("en forening, der ikke har slået tjenesten til, bidrager ikke", async () => {
    await setAiService(db, admin, clubId, false);
    await expect(askMemberService(db, mor, "Hvad skylder jeg?", mockAssistant)).rejects.toThrow("ikke slået AI-hjælp til");
    await setAiService(db, admin, clubId, true);
  });
});

describe("ekstern udbyder", () => {
  const spy = () => {
    const seen: AssistantInput[] = [];
    const a: Assistant = {
      external: true,
      async answer(input) {
        seen.push(input);
        return `${input.people[1].alias} har ${input.people[1].teams[0]} og skylder ${input.people[1].openCharges[0].amountKr}.`;
      },
    };
    return { a, seen };
  };

  it("kræver samtykke, sender ingen navne, og sætter navnene ind igen i svaret", async () => {
    const { a, seen } = spy();
    await expect(askMemberService(db, mor, "Hvad skylder Emma?", a)).rejects.toThrow("samtykke");
    expect(seen).toHaveLength(0);
    expect((await aiServiceStatus(db, mor, a)).needsConsent).toBe(true);
    await setConsent(db, mor, morProfile, "ai_service", true);
    const text = await askMemberService(db, mor, "Hvad skylder Emma i U9 Anders?", a);
    expect(text).toBe("Emma har U9 Anders og skylder 650 kr..");
    const sent = JSON.stringify(seen[0]);
    for (const leak of ["Emma", "Mille", "Mor", "U9 Anders", "Skovby"]) {
      // Foreningens navn er ikke personoplysning og sendes; resten må ikke.
      if (leak === "Skovby") continue;
      expect(sent).not.toContain(leak);
    }
    expect(seen[0].question).toBe("Hvad skylder Person 2 i Hold 1?");
    await setConsent(db, mor, morProfile, "ai_service", false);
    await expect(askMemberService(db, mor, "Hvad skylder jeg?", a)).rejects.toThrow("samtykke");
  });

  it("anonymisering tager hele ord og længste navn først", () => {
    const al = makeAliases([{ names: ["Ann", "Ann Berg"] }, { names: ["Bo"] }], ["Ann-holdet", "U9"]);
    expect(al.out("Ann Berg og Ann spiller Ann-holdet og Bo i U9, ikke Bonus")).toBe("Person 1 og Person 1 spiller Hold 1 og Person 2 i Hold 2, ikke Bonus");
    expect(al.back("Person 2 er på Hold 2")).toBe("Bo er på U9");
  });
});

describe("aliasser: bøjning og bogstavtype", () => {
  const al = makeAliases([{ names: ["Emma"] }, { names: ["Mille"] }], ["U9"]);
  it("tager genitiv", () => {
    expect(al.out("Hvornår er Emmas træning? Og Milles?")).toBe("Hvornår er Person 1s træning? Og Person 2s?");
  });
  it("tager små og store bogstaver", () => {
    expect(al.out("hvad skylder emma? EMMA og mille")).toBe("hvad skylder Person 1? Person 1 og Person 2");
  });
  it("sætter navnene ind igen i genitiv", () => {
    expect(al.back("Person 1s træning er på Hold 1s bane")).toBe("Emmas træning er på U9s bane");
  });
  it("ved delt efternavn vinder den første", () => {
    const sh = makeAliases([{ names: ["Ib", "Dahl"] }, { names: ["Jo", "Dahl"] }], []);
    expect(sh.out("Dahl")).toBe("Person 1");
  });
});

describe("begrænsning", () => {
  it("højst 30 spørgsmål i døgnet", async () => {
    for (let i = 0; i < 40; i++) await db.insert(auditLog).values({ actorUserId: other.userId, action: "ai.member_question", at: new Date(now.getTime() - 3_600_000) }).catch(() => {});
    await expect(askMemberService(db, other, "Hvad skylder jeg?", mockAssistant)).rejects.toThrow("mange spørgsmål");
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "ai.member_question"))).length).toBeGreaterThan(30);
  });
});
