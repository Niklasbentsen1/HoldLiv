// Bødekasse (modul "fines"): holdets egen bødekasse med satser og en aldersgrænse.
// Alle funktioner kalder requireModule() først, så de kun virker på hold der har modulet slået til.
//
// Regler:
//   - Satserne og beløbene bestemmer holdet selv (trænere og admin). HoldLiv har ingen standardsatser.
//   - Aldersgrænsen (indstilling pr. hold, standard 12 år) tjekkes, når bøden gives. Spillere under grænsen, eller uden
//     kendt fødselsdato, kan ikke få bøder. Ændres grænsen senere, røres gamle bøder ikke.
//   - Kun trænere og admin giver bøder, markerer dem betalt og trækker dem tilbage.
//   - Betalingen sker uden for HoldLiv (kontant eller MobilePay til holdkassen); her sættes bøden kun som betalt.
//   - Spilleren og forældrene ser egne bøder. Resten af holdet ser kun, hvor meget der er i kassen, ikke hvem der har fået hvad.
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { events, fineTypes, fines, profiles, teamMembers } from "../db/schema";
import { can, canActAs, type AccessContext } from "../auth/permissions";
import { ageOn } from "../lib/age";
import { localDate } from "../lib/money";
import { requireModule } from "./modules";


/** Teknisk øvre grænse, så et tastefejl-beløb ikke kan ødelægge kassen. 10.000 kr. */
export const MAX_FINE_ORE = 1_000_000;

const leads = (ctx: AccessContext, team: { teamId: string; clubId: string }) => can(ctx, { action: "team.manage", team });

function cleanAmount(amountOre: number) {
  if (!Number.isInteger(amountOre) || amountOre < 1 || amountOre > MAX_FINE_ORE) {
    throw new Error("Beløbet skal være mellem 0,01 og 10.000 kr.");
  }
  return amountOre;
}

async function loadFine(db: Pick<Db, "select">, fineId: string) {
  const [f] = await db.select().from(fines).where(eq(fines.id, fineId));
  if (!f) throw new Error("Bøden findes ikke");
  return f;
}

// --- Satser ---

export async function createFineType(db: Db, ctx: AccessContext, teamId: string, input: { name: string; amountOre: number }) {
  const { team } = await requireModule(db, ctx, teamId, "fines");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer ændrer bødesatser.");
  const name = input.name.trim();
  if (!name) throw new Error("Skriv hvad bøden er for.");
  const [row] = await db.insert(fineTypes).values({ teamId, name, amountOre: cleanAmount(input.amountOre) }).returning();
  return row;
}

/** Ret navn og beløb. Gamle bøder beholder det beløb, de blev givet med. */
export async function updateFineType(db: Db, ctx: AccessContext, fineTypeId: string, input: { name: string; amountOre: number }) {
  const [type] = await db.select().from(fineTypes).where(eq(fineTypes.id, fineTypeId));
  if (!type) throw new Error("Satsen findes ikke");
  const { team } = await requireModule(db, ctx, type.teamId, "fines");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer ændrer bødesatser.");
  const name = input.name.trim();
  if (!name) throw new Error("Skriv hvad bøden er for.");
  await db.update(fineTypes).set({ name, amountOre: cleanAmount(input.amountOre) }).where(eq(fineTypes.id, fineTypeId));
}

export async function setFineTypeArchived(db: Db, ctx: AccessContext, fineTypeId: string, archived: boolean) {
  const [type] = await db.select().from(fineTypes).where(eq(fineTypes.id, fineTypeId));
  if (!type) throw new Error("Satsen findes ikke");
  const { team } = await requireModule(db, ctx, type.teamId, "fines");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer ændrer bødesatser.");
  await db.update(fineTypes).set({ archivedAt: archived ? new Date() : null }).where(eq(fineTypes.id, fineTypeId));
}

// --- Bøder ---

export interface FineInput {
  profileId: string;
  /** En af holdets satser. Uden sats skal beskrivelse og beløb angives. */
  fineTypeId?: string | null;
  description?: string | null;
  amountOre?: number | null;
  eventId?: string | null;
}

/** Giv en spiller en bøde. Spilleren skal være på holdet og mindst have aldersgrænsens alder. */
export async function giveFine(db: Db, ctx: AccessContext, teamId: string, input: FineInput) {
  const { team, config } = await requireModule(db, ctx, teamId, "fines");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer giver bøder.");
  const minAge = Number(config.minAge);

  const [player] = await db
    .select({ id: profiles.id, firstName: profiles.firstName, birthDate: profiles.birthDate })
    .from(teamMembers)
    .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.profileId, input.profileId), eq(teamMembers.role, "player")));
  if (!player) throw new Error("Spilleren er ikke på holdet.");
  if (!player.birthDate) throw new Error(`${player.firstName} har ingen fødselsdato, så vi kan ikke se, om aldersgrænsen på ${minAge} år er nået.`);
  if (ageOn(player.birthDate, localDate(ctx.now)) < minAge) {
    throw new Error(`${player.firstName} er under ${minAge} år, og holdets aldersgrænse for bøder er ${minAge} år.`);
  }

  let description: string;
  let amountOre: number;
  let fineTypeId: string | null = null;
  if (input.fineTypeId) {
    const [type] = await db.select().from(fineTypes).where(and(eq(fineTypes.id, input.fineTypeId), eq(fineTypes.teamId, teamId)));
    if (!type || type.archivedAt) throw new Error("Satsen findes ikke eller er ikke i brug mere.");
    ({ name: description, amountOre } = type);
    fineTypeId = type.id;
  } else {
    description = (input.description ?? "").trim();
    if (!description) throw new Error("Skriv hvad bøden er for.");
    amountOre = cleanAmount(input.amountOre ?? 0);
  }
  if (input.eventId) {
    const [e] = await db.select({ teamId: events.teamId }).from(events).where(eq(events.id, input.eventId));
    if (!e || e.teamId !== teamId) throw new Error("Aktiviteten hører ikke til holdet.");
  }
  const [fine] = await db
    .insert(fines)
    .values({ teamId, profileId: input.profileId, fineTypeId, description, amountOre, eventId: input.eventId ?? null, givenByUserId: ctx.userId })
    .returning();
  return fine;
}

/** Sæt en bøde som betalt (eller fortryd). */
export async function setFinePaid(db: Db, ctx: AccessContext, fineId: string, paid: boolean) {
  const fine = await loadFine(db, fineId);
  const { team } = await requireModule(db, ctx, fine.teamId, "fines");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer registrerer betalinger.");
  if (fine.cancelledAt) throw new Error("Bøden er trukket tilbage.");
  await db.update(fines).set({ paidAt: paid ? new Date() : null }).where(eq(fines.id, fineId));
}

/** Træk en bøde tilbage. Den bliver stående som historik for trænerne, men tæller ikke i kassen. */
export async function cancelFine(db: Db, ctx: AccessContext, fineId: string) {
  const fine = await loadFine(db, fineId);
  const { team } = await requireModule(db, ctx, fine.teamId, "fines");
  if (!leads(ctx, team)) throw new Error("Kun trænere og administratorer trækker bøder tilbage.");
  await db.update(fines).set({ cancelledAt: new Date() }).where(and(eq(fines.id, fineId), isNull(fines.cancelledAt)));
}

/** Bødekassen: satser, kassen, egne bøder, og for trænere overblik pr. spiller og seneste bøder. */
export async function getFineBox(db: Db, ctx: AccessContext, teamId: string) {
  const { team, config } = await requireModule(db, ctx, teamId, "fines");
  const lead = leads(ctx, team);
  const minAge = Number(config.minAge);
  const today = localDate(ctx.now);

  const [types, rows, players] = await Promise.all([
    db.select().from(fineTypes).where(eq(fineTypes.teamId, teamId)).orderBy(asc(fineTypes.name)),
    db
      .select({
        fine: fines,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        eventTitle: events.title,
      })
      .from(fines)
      .innerJoin(profiles, eq(profiles.id, fines.profileId))
      .leftJoin(events, eq(events.id, fines.eventId))
      .where(eq(fines.teamId, teamId))
      .orderBy(desc(fines.createdAt)),
    db
      .select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, birthDate: profiles.birthDate })
      .from(teamMembers)
      .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "player")))
      .orderBy(asc(profiles.firstName)),
  ]);

  const live = rows.filter((r) => !r.fine.cancelledAt);
  const sum = (list: typeof live) => list.reduce((a, r) => a + r.fine.amountOre, 0);
  const view = (r: (typeof rows)[number]) => ({
    id: r.fine.id,
    playerName: `${r.firstName} ${r.lastName}`,
    description: r.fine.description,
    amountOre: r.fine.amountOre,
    paid: !!r.fine.paidAt,
    cancelled: !!r.fine.cancelledAt,
    createdAt: r.fine.createdAt,
    eventTitle: r.eventTitle,
  });

  const ages = players.map((p) => ({ ...p, age: p.birthDate ? ageOn(p.birthDate, today) : null }));
  return {
    canManage: lead,
    minAge,
    types: lead ? types.map((t) => ({ id: t.id, name: t.name, amountOre: t.amountOre, archived: !!t.archivedAt })) : types.filter((t) => !t.archivedAt).map((t) => ({ id: t.id, name: t.name, amountOre: t.amountOre, archived: false })),
    box: {
      count: live.length,
      paidOre: sum(live.filter((r) => r.fine.paidAt)),
      openOre: sum(live.filter((r) => !r.fine.paidAt)),
    },
    /** Egne og børnenes bøder. */
    mine: live.filter((r) => canActAs(ctx, r.fine.profileId)).map(view),
    /** Kun for trænere: alle spillere med deres tal, og om de er gamle nok til at få en bøde. */
    players: lead
      ? ages.map((p) => ({
          profileId: p.id,
          name: `${p.firstName} ${p.lastName}`,
          age: p.age,
          eligible: p.age !== null && p.age >= minAge,
          openOre: sum(live.filter((r) => r.fine.profileId === p.id && !r.fine.paidAt)),
          paidOre: sum(live.filter((r) => r.fine.profileId === p.id && r.fine.paidAt)),
        }))
      : [],
    /** Kun for trænere: de seneste bøder, også de trukne tilbage. */
    recent: lead ? rows.slice(0, 40).map(view) : [],
  };
}
