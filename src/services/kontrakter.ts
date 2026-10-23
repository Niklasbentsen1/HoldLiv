// Kontrakter mellem foreningen og en person, fx en trænerkontrakt.
//
// Regler:
//   - Kun foreningens admin opretter, sender og trækker kontrakter tilbage. Teksten og et eventuelt månedligt beløb bestemmer foreningen selv.
//     HoldLiv har ingen standardbeløb; skabelonerne er kun et udgangspunkt uden tal.
//   - En kontrakt kan rettes som kladde. Ved afsendelse låses teksten med et hash, og underskriften gælder præcis den tekst.
//   - Personen skriver under ved at skrive sit fulde navn. Er personen under 18 år, skriver en værge under. Det er en enkel accept,
//     ikke en kvalificeret elektronisk signatur (MitID). Kontrakter, der kræver det, skal skrives under på anden vis.
//   - En underskrevet kontrakt kan ikke rettes, kun trækkes tilbage (og erstattes af en ny).
//   - Modtageren får besked ved afsendelse og en påmindelse, hvis kontrakten ikke er underskrevet efter en uge. Admin får besked 30 dage før en kontrakt udløber.
import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { contracts, profiles } from "../db/schema";
import { assertCan, type AccessContext } from "../auth/permissions";
import { addDays, kr, localDate, longDate } from "../lib/money";
import { logAudit } from "./audit";
import { adminRecipients, assertSigner, belongsToClub } from "./attester";
import { notifyUsers, recipientsOfPlayers, type Deliver } from "./notifications";

export const CONTRACT_KIND_LABEL = { coach: "Trænerkontrakt", player: "Spillerkontrakt", volunteer: "Frivilligaftale", other: "Andet" } as const;
export type ContractKind = keyof typeof CONTRACT_KIND_LABEL;
export const CONTRACT_STATUS_LABEL = { draft: "Kladde", sent: "Til underskrift", signed: "Underskrevet", declined: "Afvist", cancelled: "Trukket tilbage" } as const;

/** Teknisk øvre grænse: 100.000 kr. om måneden. */
export const MAX_MONTHLY_AMOUNT_ORE = 10_000_000;
const MAX_BODY = 20_000;
const REMIND_AFTER_DAYS = 7;
export const EXPIRY_NOTICE_DAYS = 30;

export interface ContractInput {
  profileId: string;
  kind: ContractKind;
  title: string;
  body: string;
  startsOn: string;
  endsOn?: string | null;
  /** Aftalt månedligt beløb i øre. Tomt eller 0 = ingen betaling. */
  monthlyAmountOre?: number | null;
}

const isDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const hashOf = (title: string, body: string, startsOn: string, endsOn: string | null, amount: number | null) =>
  createHash("sha256").update(JSON.stringify([title, body, startsOn, endsOn, amount])).digest("hex");

function clean(input: ContractInput) {
  if (!(input.kind in CONTRACT_KIND_LABEL)) throw new Error("Vælg en slags kontrakt.");
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) throw new Error("Giv kontrakten en titel.");
  if (title.length > 160) throw new Error("Titlen må højst være på 160 tegn.");
  if (!body) throw new Error("Kontrakten skal have en tekst.");
  if (body.length > MAX_BODY) throw new Error(`Teksten må højst være på ${MAX_BODY.toLocaleString("da-DK")} tegn.`);
  if (!isDate(input.startsOn)) throw new Error("Vælg en startdato.");
  const endsOn = input.endsOn || null;
  if (endsOn !== null) {
    if (!isDate(endsOn)) throw new Error("Slutdatoen er ugyldig.");
    if (endsOn < input.startsOn) throw new Error("Slutdatoen skal ligge efter startdatoen.");
  }
  const amount = input.monthlyAmountOre ? input.monthlyAmountOre : null;
  if (amount !== null && (!Number.isInteger(amount) || amount < 0 || amount > MAX_MONTHLY_AMOUNT_ORE)) throw new Error("Beløbet skal være mellem 0 og 100.000 kr. om måneden.");
  return { kind: input.kind, title, body, startsOn: input.startsOn, endsOn, monthlyAmountOre: amount };
}

/** Et udgangspunkt for teksten, uden beløb og uden juridisk garanti. Foreningen retter og lader gerne en jurist se den. */
export function contractTemplate(kind: ContractKind): string {
  const common = `Parterne
Foreningen og den person, kontrakten er sendt til.

Varighed
Aftalen gælder fra startdatoen og, hvis der er en slutdato, til den. Begge parter kan opsige aftalen skriftligt med det varsel, der er skrevet herunder.

Opsigelse
Varsel: [skriv varsel]

Persondata
Foreningen behandler oplysninger om personen, så længe aftalen består, og efter reglerne i foreningens privatlivspolitik.`;
  const body: Record<ContractKind, string> = {
    coach: `Trænerkontrakt

Opgaver
Personen er træner for [hold] og planlægger og leder træning og kampe. Personen følger foreningens retningslinjer for børn og unge.

Vederlag
[Skriv aftalt vederlag og hvordan det udbetales, eller at opgaven er ulønnet.]

Børneattest
Personen giver samtykke til, at foreningen indhenter en børneattest, og at foreningen registrerer, om attesten er godkendt og hvornår den udløber.`,
    player: `Spillerkontrakt

Opgaver
Personen spiller for [hold] og deltager i træning og kampe efter holdets plan.

Vilkår
[Skriv aftalte vilkår, fx kontingent, udstyr og eventuel godtgørelse.]`,
    volunteer: `Frivilligaftale

Opgaver
Personen hjælper foreningen med [opgaver]. Opgaven er ulønnet.

Børneattest
Kræver opgaven kontakt med børn, giver personen samtykke til, at foreningen indhenter en børneattest.`,
    other: `Aftale

Indhold
[Skriv aftalen her.]`,
  };
  return `${body[kind]}\n\n${common}`;
}

async function load(db: Pick<Db, "select">, id: string) {
  const [c] = await db.select().from(contracts).where(eq(contracts.id, id));
  if (!c) throw new Error("Kontrakten findes ikke.");
  return c;
}

export async function createContract(db: Db, ctx: AccessContext, clubId: string, input: ContractInput) {
  assertCan(ctx, { action: "club.manage", clubId });
  if (!(await belongsToClub(db, clubId, input.profileId))) throw new Error("Personen hører ikke til foreningen.");
  const [c] = await db.insert(contracts).values({ clubId, profileId: input.profileId, createdByUserId: ctx.userId, ...clean(input) }).returning();
  await logAudit(db, { action: "contract.created", clubId, actorUserId: ctx.userId, targetType: "contract", targetId: c.id });
  return c;
}

export async function updateContract(db: Db, ctx: AccessContext, contractId: string, input: Omit<ContractInput, "profileId">) {
  const c = await load(db, contractId);
  assertCan(ctx, { action: "club.manage", clubId: c.clubId });
  if (c.status !== "draft") throw new Error("Kun en kladde kan rettes. Træk kontrakten tilbage og lav en ny.");
  const done = await db.update(contracts).set(clean({ ...input, profileId: c.profileId })).where(and(eq(contracts.id, contractId), eq(contracts.status, "draft"))).returning({ id: contracts.id });
  if (done.length === 0) throw new Error("Kun en kladde kan rettes.");
  await logAudit(db, { action: "contract.updated", clubId: c.clubId, actorUserId: ctx.userId, targetType: "contract", targetId: contractId });
}

export async function deleteDraftContract(db: Db, ctx: AccessContext, contractId: string) {
  const c = await load(db, contractId);
  assertCan(ctx, { action: "club.manage", clubId: c.clubId });
  const done = await db.delete(contracts).where(and(eq(contracts.id, contractId), eq(contracts.status, "draft"))).returning({ id: contracts.id });
  if (done.length === 0) throw new Error("Kun en kladde kan slettes.");
  await logAudit(db, { action: "contract.draft_deleted", clubId: c.clubId, actorUserId: ctx.userId, targetType: "contract", targetId: contractId });
}

/** Sender kontrakten til underskrift. Teksten låses, og modtageren (eller værgen) får besked. */
export async function sendContract(db: Db, ctx: AccessContext, contractId: string, deliver?: Deliver) {
  const c = await load(db, contractId);
  assertCan(ctx, { action: "club.manage", clubId: c.clubId });
  if (c.status !== "draft") throw new Error("Kontrakten er allerede sendt.");
  const done = await db
    .update(contracts)
    .set({ status: "sent", sentAt: ctx.now, bodyHash: hashOf(c.title, c.body, c.startsOn, c.endsOn, c.monthlyAmountOre) })
    .where(and(eq(contracts.id, contractId), eq(contracts.status, "draft")))
    .returning({ id: contracts.id });
  if (done.length === 0) throw new Error("Kontrakten er allerede sendt.");
  await logAudit(db, { action: "contract.sent", clubId: c.clubId, actorUserId: ctx.userId, targetType: "contract", targetId: contractId });
  if (!deliver) return;
  await notifyUsers(db, deliver, await recipientsOfPlayers(db, [c.profileId], ctx.now), {
    kind: "volunteer",
    subject: `Kontrakt til underskrift: ${c.title}`,
    body: `Foreningen har sendt dig kontrakten "${c.title}". Læs den og skriv under under Kontrakter i HoldLiv.`,
    sms: `Kontrakten "${c.title}" venter på din underskrift.`,
    url: "/kontrakter",
    dedupeKey: `contract:${contractId}:sent`,
  });
}

/** Personen (eller værgen) skriver under ved at skrive sit fulde navn. */
export async function signContract(db: Db, ctx: AccessContext, contractId: string, typedName: string) {
  const c = await load(db, contractId);
  const { signerName } = await assertSigner(db, ctx, c.profileId);
  if (c.status !== "sent") throw new Error(c.status === "signed" ? "Kontrakten er allerede underskrevet." : "Kontrakten kan ikke underskrives.");
  if (c.bodyHash !== hashOf(c.title, c.body, c.startsOn, c.endsOn, c.monthlyAmountOre)) throw new Error("Kontraktens tekst er ændret efter afsendelsen. Bed foreningen sende den igen.");
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase("da");
  if (norm(typedName) !== norm(signerName)) throw new Error("Skriv dit fulde navn, som det står på din profil, for at skrive under.");
  const done = await db
    .update(contracts)
    .set({ status: "signed", signedAt: ctx.now, signedByUserId: ctx.userId, signedName: signerName })
    .where(and(eq(contracts.id, contractId), eq(contracts.status, "sent")))
    .returning({ id: contracts.id });
  if (done.length === 0) throw new Error("Kontrakten kan ikke underskrives.");
  await logAudit(db, { action: "contract.signed", clubId: c.clubId, actorUserId: ctx.userId, targetType: "contract", targetId: contractId });
}

export async function declineContract(db: Db, ctx: AccessContext, contractId: string, reason?: string | null) {
  const c = await load(db, contractId);
  await assertSigner(db, ctx, c.profileId);
  const done = await db
    .update(contracts)
    .set({ status: "declined", declinedReason: reason?.trim().slice(0, 500) || null })
    .where(and(eq(contracts.id, contractId), eq(contracts.status, "sent")))
    .returning({ id: contracts.id });
  if (done.length === 0) throw new Error("Kontrakten kan ikke afvises.");
  await logAudit(db, { action: "contract.declined", clubId: c.clubId, actorUserId: ctx.userId, targetType: "contract", targetId: contractId });
}

/** Foreningen trækker en sendt eller underskrevet kontrakt tilbage. */
export async function cancelContract(db: Db, ctx: AccessContext, contractId: string) {
  const c = await load(db, contractId);
  assertCan(ctx, { action: "club.manage", clubId: c.clubId });
  const done = await db.update(contracts).set({ status: "cancelled" }).where(and(eq(contracts.id, contractId), inArray(contracts.status, ["sent", "signed"]))).returning({ id: contracts.id });
  if (done.length === 0) throw new Error("Kontrakten kan ikke trækkes tilbage.");
  await logAudit(db, { action: "contract.cancelled", clubId: c.clubId, actorUserId: ctx.userId, targetType: "contract", targetId: contractId });
}

/** Foreningens kontrakter, nyeste først. Underskrevne, der udløber inden 30 dage, er markeret. Kun admin. */
export async function listClubContracts(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "club.manage", clubId });
  const rows = await db
    .select({ c: contracts, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(contracts)
    .innerJoin(profiles, eq(profiles.id, contracts.profileId))
    .where(eq(contracts.clubId, clubId))
    .orderBy(desc(contracts.createdAt));
  const today = localDate(ctx.now);
  return rows.map(({ c, firstName, lastName }) => ({
    ...c,
    name: `${firstName} ${lastName}`,
    expired: c.status === "signed" && c.endsOn !== null && c.endsOn < today,
    expiresSoon: c.status === "signed" && c.endsOn !== null && c.endsOn >= today && c.endsOn <= addDays(today, EXPIRY_NOTICE_DAYS),
  }));
}

/** Kontrakter til en selv og ens børn (ikke kladder). */
export async function listMyContracts(db: Db, ctx: AccessContext) {
  const people = [ctx.profileId, ...ctx.wards];
  const rows = await db
    .select({ c: contracts, firstName: profiles.firstName, club: profiles.id })
    .from(contracts)
    .innerJoin(profiles, eq(profiles.id, contracts.profileId))
    .where(and(inArray(contracts.profileId, people), ne(contracts.status, "draft")))
    .orderBy(desc(contracts.createdAt));
  const out = [];
  for (const { c, firstName } of rows) {
    let canSign = false;
    if (c.status === "sent") {
      try {
        await assertSigner(db, ctx, c.profileId);
        canSign = true;
      } catch {
        canSign = false;
      }
    }
    out.push({ ...c, firstName, self: c.profileId === ctx.profileId, canSign, amountLabel: c.monthlyAmountOre ? `${kr(c.monthlyAmountOre)} om måneden` : null });
  }
  return out;
}

/**
 * Påmindelser. Kan køres så ofte, man vil:
 *   - Modtageren får en påmindelse, når en sendt kontrakt har ligget i en uge uden underskrift (højst én gang pr. uge).
 *   - Admin får én besked pr. kontrakt, når en underskrevet kontrakt udløber inden 30 dage.
 */
export async function sendContractReminders(db: Db, deliver: Deliver, now = new Date()) {
  const weekAgo = new Date(now.getTime() - REMIND_AFTER_DAYS * 86400000);
  const unsigned = await db
    .select()
    .from(contracts)
    .where(and(eq(contracts.status, "sent"), lte(contracts.sentAt, weekAgo), or(isNull(contracts.reminderSentAt), lte(contracts.reminderSentAt, weekAgo))));
  let remindersSent = 0;
  for (const c of unsigned) {
    const claimed = await db
      .update(contracts)
      .set({ reminderSentAt: now })
      .where(and(eq(contracts.id, c.id), eq(contracts.status, "sent"), or(isNull(contracts.reminderSentAt), lte(contracts.reminderSentAt, weekAgo))))
      .returning({ id: contracts.id });
    if (claimed.length === 0) continue;
    const res = await notifyUsers(db, deliver, await recipientsOfPlayers(db, [c.profileId], now), {
      kind: "volunteer",
      subject: `Påmindelse: kontrakten "${c.title}" venter på underskrift`,
      body: `Kontrakten "${c.title}" er stadig ikke underskrevet. Du finder den under Kontrakter i HoldLiv.`,
      sms: `Kontrakten "${c.title}" venter på din underskrift.`,
      url: "/kontrakter",
      dedupeKey: `contract:${c.id}:reminder:${localDate(now)}`,
    });
    remindersSent += res.sent;
  }
  const today = localDate(now);
  const expiring = await db
    .select({ c: contracts, firstName: profiles.firstName, lastName: profiles.lastName })
    .from(contracts)
    .innerJoin(profiles, eq(profiles.id, contracts.profileId))
    .where(and(eq(contracts.status, "signed"), isNotNull(contracts.endsOn), lte(contracts.endsOn, addDays(today, EXPIRY_NOTICE_DAYS)), isNull(contracts.expiryNoticeSentAt)));
  let noticesSent = 0;
  for (const { c, firstName, lastName } of expiring) {
    if (c.endsOn! < today) continue;
    const claimed = await db.update(contracts).set({ expiryNoticeSentAt: now }).where(and(eq(contracts.id, c.id), isNull(contracts.expiryNoticeSentAt))).returning({ id: contracts.id });
    if (claimed.length === 0) continue;
    const res = await notifyUsers(db, deliver, await adminRecipients(db, c.clubId), {
      kind: "volunteer",
      subject: `Kontrakt udløber ${longDate(c.endsOn!)}: ${firstName} ${lastName}`,
      body: `Kontrakten "${c.title}" med ${firstName} ${lastName} udløber ${longDate(c.endsOn!)}. Lav en ny, hvis aftalen skal fortsætte. Se Forening, Kontrakter.`,
      sms: `Kontrakten med ${firstName} ${lastName} udløber ${longDate(c.endsOn!)}.`,
      url: `/forening/kontrakter?klub=${c.clubId}`,
      dedupeKey: `contract:${c.id}:expiry`,
    });
    noticesSent += res.sent;
  }
  return { remindersSent, noticesSent };
}

// Bruges af tests og sider, der kun skal vide, om en person har en gyldig underskrevet kontrakt af en art.
export async function hasActiveContract(db: Pick<Db, "select">, clubId: string, profileId: string, kind: ContractKind, on: Date) {
  const day = localDate(on);
  const rows = await db
    .select({ endsOn: contracts.endsOn, startsOn: contracts.startsOn })
    .from(contracts)
    .where(and(eq(contracts.clubId, clubId), eq(contracts.profileId, profileId), eq(contracts.kind, kind), eq(contracts.status, "signed"), lte(contracts.startsOn, day)));
  return rows.some((r) => r.endsOn === null || r.endsOn >= day);
}
