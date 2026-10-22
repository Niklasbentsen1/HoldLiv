// AI-medlemsservice (arbejdsplan 21): svarer forældre og medlemmer ud fra de oplysninger, de selv har adgang til.
//
// Regler:
//   - Foreningen slår tjenesten til (slået fra som standard). Kun foreninger, der har slået den til, bidrager med oplysninger.
//   - Oplysningerne er kun personens egne og børnenes, personen er værge for: kommende aktiviteter, ubetalte opkrævninger og hold.
//     Aldrig andre medlemmer, adresser, e-mails, telefonnumre eller fødselsdatoer.
//   - En ekstern udbyder (Anthropic) får oplysningerne uden navne: personer hedder "Person 1…", hold "Hold 1…", og navnene sættes ind
//     igen i svaret. Det kræver desuden personens eget samtykke (Privatliv). Mock-udbyderen sender intet ud af HoldLiv.
//   - Tjenesten kan kun svare. Den kan ikke betale, tilmelde eller ændre noget, og svaret bruges aldrig som en kommando.
//   - Højst 30 spørgsmål i døgnet pr. login. Selve spørgsmålet gemmes ikke, kun at det blev stillet.
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditLog, clubMemberships, clubs, profiles, teamMembers, teams } from "../db/schema";
import { assertCan, type AccessContext } from "../auth/permissions";
import type { Assistant, AssistantInput, AssistantPerson } from "../lib/memberAssistant";
import { kr, localDate } from "../lib/money";
import { logAudit } from "./audit";
import { hasConsent } from "./gdpr";
import { listMyCharges } from "./finance";
import { listUpcomingEvents } from "./index";

export const MAX_QUESTIONS_PER_DAY = 30;
export const MAX_QUESTION_LENGTH = 500;
const HORIZON_DAYS = 21;

export async function setAiService(db: Db, ctx: AccessContext, clubId: string, enabled: boolean) {
  assertCan(ctx, { action: "club.manage", clubId });
  await db.update(clubs).set({ aiServiceEnabled: enabled }).where(eq(clubs.id, clubId));
  await logAudit(db, { action: "ai.service_setting", clubId, actorUserId: ctx.userId, detail: { enabled } });
}

/** Er der en forening, hvor login'et (eller dets børn) er medlem, der har slået tjenesten til? */
export async function aiServiceStatus(db: Db, ctx: AccessContext, assistant: Assistant | null) {
  const ids = [ctx.profileId, ...ctx.wards];
  const rows = await db
    .select({ id: clubs.id, name: clubs.name, enabled: clubs.aiServiceEnabled })
    .from(clubMemberships)
    .innerJoin(clubs, eq(clubs.id, clubMemberships.clubId))
    .where(inArray(clubMemberships.profileId, ids));
  const enabled = [...new Map(rows.filter((r) => r.enabled).map((r) => [r.id, r.name])).values()];
  const consent = await hasConsent(db, ctx.profileId, "ai_service");
  return { available: !!assistant && enabled.length > 0, clubs: enabled, needsConsent: !!assistant?.external && !consent, consent };
}

const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const edge = (core: string) => new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${core})(?![\\p{L}\\p{N}_-])`, "gu");

/** Navne på personer og hold erstattes med aliasser, før noget sendes, og sættes ind igen i svaret. Hele ord, længste navn først. */
export function makeAliases(people: { names: string[] }[], teamNames: string[]) {
  const entries: { text: string; alias: string }[] = [];
  people.forEach((p, i) => p.names.filter(Boolean).forEach((n) => entries.push({ text: n, alias: `Person ${i + 1}` })));
  teamNames.forEach((n, i) => n && entries.push({ text: n, alias: `Hold ${i + 1}` }));
  const longest = [...entries].sort((a, b) => b.text.length - a.text.length);
  const nameRe = longest.length ? edge(longest.map((e) => escape(e.text)).join("|")) : null;
  const aliasOf = new Map(longest.map((e) => [e.text, e.alias]));
  // Tilbage: det første navn, der hørte til aliasset (fornavn for en person, hele navnet for et hold).
  const firstFor = new Map<string, string>();
  for (const e of entries) if (!firstFor.has(e.alias)) firstFor.set(e.alias, e.text);
  return {
    out: (text: string) => (nameRe ? text.replace(nameRe, (m) => aliasOf.get(m) ?? m) : text),
    back: (text: string) => text.replace(edge("(?:Person|Hold) \\d+"), (m) => firstFor.get(m) ?? m),
  };
}

/** De oplysninger, tjenesten må bruge: kun personens egne og børnenes, og kun fra foreninger, der har slået den til. */
export async function collectFacts(db: Db, ctx: AccessContext) {
  const ids = [ctx.profileId, ...ctx.wards];
  const memberships = await db
    .select({ profileId: clubMemberships.profileId, clubId: clubs.id, clubName: clubs.name })
    .from(clubMemberships)
    .innerJoin(clubs, and(eq(clubs.id, clubMemberships.clubId), eq(clubs.aiServiceEnabled, true)))
    .where(inArray(clubMemberships.profileId, ids));
  const clubIds = new Set(memberships.map((m) => m.clubId));
  const clubNames = [...new Set(memberships.map((m) => m.clubName))];
  const nameRows = await db.select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName }).from(profiles).where(inArray(profiles.id, ids));
  const teamRows = await db
    .select({ profileId: teamMembers.profileId, teamId: teams.id, name: teams.name, clubId: teams.clubId })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(inArray(teamMembers.profileId, ids));
  const teamClub = new Map(teamRows.map((t) => [t.teamId, t.clubId]));
  const charges = await listMyCharges(db, ctx);
  const now = ctx.now;
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 86_400_000);
  const people: (AssistantPerson & { profileId: string; names: string[] })[] = [];
  for (const id of ids) {
    if (!memberships.some((m) => m.profileId === id)) continue;
    const n = nameRows.find((r) => r.id === id);
    const upcoming = (await listUpcomingEvents(db, ctx, id, now, horizon)).filter((e) => clubIds.has(teamClub.get(e.teamId) ?? ""));
    people.push({
      profileId: id,
      names: n ? [n.firstName, `${n.firstName} ${n.lastName}`, n.lastName] : [],
      alias: "",
      relation: id === ctx.profileId ? "dig" : "dit barn",
      teams: teamRows.filter((t) => t.profileId === id && clubIds.has(t.clubId)).map((t) => t.name),
      upcoming: upcoming.map((e) => ({
        title: e.title,
        type: e.type,
        startsAt: e.startsAt.toISOString(),
        location: e.location,
        team: e.teamName,
        cancelled: !!e.cancelledAt,
        answer: e.status === "yes" ? "kommer" : e.status === "no" ? "kommer ikke" : e.status === "maybe" ? "måske" : "ikke svaret",
      })),
      openCharges: charges.open
        .filter((c) => c.profileId === id && clubIds.has(c.clubId))
        .map((c) => ({ description: c.description, amountKr: kr(c.amountOre), dueDate: c.dueDate, overdue: c.overdue })),
    });
  }
  return { today: localDate(now), clubs: clubNames, people };
}

/** Besvarer et spørgsmål ud fra personens egne oplysninger. */
export async function askMemberService(db: Db, ctx: AccessContext, question: string, assistant: Assistant) {
  const q = question.trim();
  if (!q) throw new Error("Skriv dit spørgsmål.");
  if (q.length > MAX_QUESTION_LENGTH) throw new Error(`Spørgsmålet må højst være på ${MAX_QUESTION_LENGTH} tegn.`);
  const since = new Date(ctx.now.getTime() - 24 * 3_600_000);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(and(eq(auditLog.actorUserId, ctx.userId), eq(auditLog.action, "ai.member_question"), gte(auditLog.at, since)));
  if (n >= MAX_QUESTIONS_PER_DAY) throw new Error("Du har stillet mange spørgsmål i dag. Prøv igen i morgen, eller skriv til foreningen.");
  const facts = await collectFacts(db, ctx);
  if (facts.people.length === 0) throw new Error("Foreningen har ikke slået AI-hjælp til.");
  if (assistant.external && !(await hasConsent(db, ctx.profileId, "ai_service"))) throw new Error("Du skal først give samtykke til AI-hjælp under Privatliv.");

  const teamNames = [...new Set(facts.people.flatMap((p) => [...p.teams, ...p.upcoming.map((e) => e.team)]))];
  const aliases = makeAliases(facts.people, teamNames);
  const teamAlias = (t: string) => `Hold ${teamNames.indexOf(t) + 1}`;
  const input: AssistantInput = {
    today: facts.today,
    question: aliases.out(q),
    clubs: facts.clubs.map((c) => c),
    people: facts.people.map((p, i) => ({
      alias: `Person ${i + 1}`,
      relation: p.relation,
      teams: p.teams.map(teamAlias),
      upcoming: p.upcoming.map((e) => ({ ...e, title: aliases.out(e.title), location: e.location ? aliases.out(e.location) : null, team: teamAlias(e.team) })),
      openCharges: p.openCharges.map((c) => ({ ...c, description: aliases.out(c.description) })),
    })),
  };
  const text = aliases.back(await assistant.answer(input));
  await logAudit(db, { action: "ai.member_question", actorUserId: ctx.userId, detail: { external: assistant.external, length: q.length } });
  return text;
}
