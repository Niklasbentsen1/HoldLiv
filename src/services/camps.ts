// Camps og arrangementer med tilmelding, betaling, venteliste og søskenderabat.
//
// Regler:
//   - Pris, antal pladser, frist og søskenderabat bestemmer foreningens egen admin/kasserer. HoldLiv har ingen standardsatser.
//   - Medlemmer af foreningen tilmeldes af sig selv eller af en forælder (for børn under 18). Kun én aktiv tilmelding pr. person.
//   - Er campen fuld, eller venter der allerede nogen, havner man på ventelisten (rækkefølgen er tilmeldingstidspunktet). Bliver en
//     plads fri, rykker den første på ventelisten op, får en opkrævning og besked.
//   - Pladsen bekræftes, når opkrævningen oprettes; den betales som alle andre opkrævninger under Betaling. Betales den ikke, kan
//     foreningen afmelde personen, og pladsen går videre.
//   - Søskenderabat: den første i en familie (fælles forælder) med en bekræftet plads betaler fuld pris, de næste får foreningens procent. Rabatten regnes,
//     når pladsen bekræftes, og ændres ikke bagefter.
//   - Afmelding af en betalt plads kræver, at kassereren har refunderet opkrævningen først.
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { campSignups, camps, charges, clubMemberships, guardianships, profiles } from "../db/schema";
import { assertCan, canActAs, type AccessContext } from "../auth/permissions";
import { addDays, kr, localDate } from "../lib/money";
import { logAudit } from "./audit";
import { notifyUsers, recipientsOfPlayers, type Deliver } from "./notifications";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Teknisk øvre grænse: 50.000 kr. */
export const MAX_CAMP_PRICE_ORE = 5_000_000;

export interface CampInput {
  name: string;
  description?: string | null;
  startsOn: string;
  endsOn: string;
  priceOre: number;
  siblingDiscountPercent?: number;
  capacity?: number | null;
  signupDeadline?: string | null;
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

function clean(input: CampInput) {
  const name = input.name.trim();
  if (!name) throw new Error("Giv campen et navn.");
  if (name.length > 120) throw new Error("Navnet må højst være på 120 tegn.");
  if (!isDate(input.startsOn) || !isDate(input.endsOn)) throw new Error("Vælg start- og slutdato.");
  if (input.endsOn < input.startsOn) throw new Error("Slutdatoen kan ikke ligge før startdatoen.");
  if (!Number.isInteger(input.priceOre) || input.priceOre < 0 || input.priceOre > MAX_CAMP_PRICE_ORE) throw new Error("Prisen skal være mellem 0 og 50.000 kr.");
  const sibling = input.siblingDiscountPercent ?? 0;
  if (!Number.isInteger(sibling) || sibling < 0 || sibling > 100) throw new Error("Søskenderabatten skal være et helt tal fra 0 til 100 procent.");
  const capacity = input.capacity ?? null;
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 0 || capacity > 5000)) throw new Error("Antal pladser skal være et helt tal fra 0 til 5.000.");
  const deadline = input.signupDeadline || null;
  if (deadline && (!isDate(deadline) || deadline > input.endsOn)) throw new Error("Tilmeldingsfristen skal være en dato, før campen er slut.");
  return { name, description: input.description?.trim() || null, startsOn: input.startsOn, endsOn: input.endsOn, priceOre: input.priceOre, siblingDiscountPercent: sibling, capacity, signupDeadline: deadline };
}

export async function createCamp(db: Db, ctx: AccessContext, clubId: string, input: CampInput) {
  assertCan(ctx, { action: "finance.manage", clubId });
  const [camp] = await db.insert(camps).values({ clubId, createdByUserId: ctx.userId, ...clean(input) }).returning();
  await logAudit(db, { action: "camp.created", clubId, actorUserId: ctx.userId, targetType: "camp", targetId: camp.id });
  return camp;
}

async function loadCamp(db: Pick<Db, "select">, campId: string) {
  const [c] = await db.select().from(camps).where(eq(camps.id, campId));
  if (!c) throw new Error("Campen findes ikke");
  return c;
}

/** Retter en camp. Prisen gælder kun nye bekræftelser; opkrævninger, der allerede er lavet, ændres ikke. Flere pladser rykker folk op. */
export async function updateCamp(db: Db, ctx: AccessContext, campId: string, input: CampInput, deliver?: Deliver) {
  const camp = await loadCamp(db, campId);
  assertCan(ctx, { action: "finance.manage", clubId: camp.clubId });
  if (camp.cancelledAt) throw new Error("Campen er aflyst.");
  await db.update(camps).set(clean(input)).where(eq(camps.id, campId));
  await logAudit(db, { action: "camp.updated", clubId: camp.clubId, actorUserId: ctx.userId, targetType: "camp", targetId: campId });
  await promoteWaitlist(db, campId, ctx.userId, ctx.now, deliver);
}

/** Aflyser campen: åbne opkrævninger annulleres, deltagerne får besked. Betalte opkrævninger skal kassereren refundere. */
export async function cancelCamp(db: Db, ctx: AccessContext, campId: string, deliver?: Deliver) {
  const camp = await loadCamp(db, campId);
  assertCan(ctx, { action: "finance.manage", clubId: camp.clubId });
  if (camp.cancelledAt) throw new Error("Campen er allerede aflyst.");
  const signups = await db.select().from(campSignups).where(and(eq(campSignups.campId, campId), ne(campSignups.status, "cancelled")));
  const chargeIds = signups.flatMap((s) => (s.chargeId ? [s.chargeId] : []));
  const paid = chargeIds.length ? await db.select({ id: charges.id }).from(charges).where(and(inArray(charges.id, chargeIds), eq(charges.status, "paid"))) : [];
  await db.transaction(async (tx) => {
    await tx.update(camps).set({ cancelledAt: ctx.now }).where(eq(camps.id, campId));
    if (chargeIds.length) await tx.update(charges).set({ status: "cancelled" }).where(and(inArray(charges.id, chargeIds), eq(charges.status, "open")));
  });
  await logAudit(db, { action: "camp.cancelled", clubId: camp.clubId, actorUserId: ctx.userId, targetType: "camp", targetId: campId, detail: { signups: signups.length, paid: paid.length } });
  if (deliver && signups.length) {
    await notifyUsers(db, deliver, await recipientsOfPlayers(db, signups.map((s) => s.profileId), ctx.now), {
      kind: "event_change",
      subject: `${camp.name} er aflyst`,
      body: `${camp.name} er desværre aflyst. Har du allerede betalt, hører du fra kassereren om at få pengene tilbage.`,
      sms: `${camp.name} er aflyst.`,
      url: "/camps",
      dedupeKey: `camp:${campId}:cancelled`,
    });
  }
  return { cancelledSignups: signups.length, paidToRefund: paid.length };
}

async function spotCounts(db: Pick<Db, "select">, campId: string) {
  const rows = await db.select({ status: campSignups.status, n: sql<number>`count(*)::int` }).from(campSignups).where(eq(campSignups.campId, campId)).groupBy(campSignups.status);
  const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return { confirmed: n("confirmed"), waiting: n("waitlist") };
}

/** Søskende til personen (fælles forælder) med en bekræftet plads på campen. Ventelisten tæller ikke med. */
async function siblingsSignedUp(db: Pick<Db, "select">, campId: string, profileId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(campSignups)
    .innerJoin(guardianships, eq(guardianships.childProfileId, campSignups.profileId))
    .where(
      and(
        eq(campSignups.campId, campId),
        eq(campSignups.status, "confirmed"),
        ne(campSignups.profileId, profileId),
        sql`${guardianships.guardianProfileId} in (select guardian_profile_id from guardianships where child_profile_id = ${profileId})`,
      ),
    );
  return row.n > 0;
}

/** Bekræfter pladsen: regner prisen (med søskenderabat) og opretter opkrævningen. */
async function confirmSignup(tx: Tx, camp: typeof camps.$inferSelect, signupId: string, profileId: string, userId: string | null, now: Date) {
  const sibling = camp.siblingDiscountPercent > 0 && (await siblingsSignedUp(tx, camp.id, profileId));
  const discount = sibling ? camp.siblingDiscountPercent : 0;
  const amountOre = Math.round((camp.priceOre * (100 - discount)) / 100);
  const today = localDate(now);
  const due = camp.signupDeadline && camp.signupDeadline >= today ? camp.signupDeadline : addDays(today, 14);
  const [charge] = await tx
    .insert(charges)
    .values({
      clubId: camp.clubId,
      profileId,
      description: `${camp.name}${discount ? ` (søskenderabat ${discount} %)` : ""}`,
      amountOre,
      periodStart: camp.startsOn,
      periodEnd: camp.endsOn,
      dueDate: due,
      kind: "camp",
      status: amountOre === 0 ? "paid" : "open",
      paidAt: amountOre === 0 ? now : null,
      createdByUserId: userId,
    })
    .returning({ id: charges.id });
  await tx.update(campSignups).set({ status: "confirmed", chargeId: charge.id, discountPercent: discount }).where(eq(campSignups.id, signupId));
  return { amountOre, discount };
}

/** Tilmelder en person (en selv eller et barn, man er værge for) til en camp. Giver plads eller ventelisteplads. */
export async function signUpForCamp(db: Db, ctx: AccessContext, campId: string, profileId: string) {
  if (!canActAs(ctx, profileId)) assertCan(ctx, { action: "profile.actAs", profileId });
  const camp0 = await loadCamp(db, campId);
  const [m] = await db.select({ p: clubMemberships.profileId }).from(clubMemberships).where(and(eq(clubMemberships.clubId, camp0.clubId), eq(clubMemberships.profileId, profileId)));
  if (!m) throw new Error("Kun medlemmer af foreningen kan tilmeldes.");
  const result = await db.transaction(async (tx) => {
    // Lås campen, så to samtidige tilmeldinger ikke begge tager den sidste plads.
    const [camp] = await tx.select().from(camps).where(eq(camps.id, campId)).for("update");
    if (camp.cancelledAt) throw new Error("Campen er aflyst.");
    const today = localDate(ctx.now);
    if (today > (camp.signupDeadline ?? camp.endsOn)) throw new Error("Tilmeldingen er lukket.");
    const [existing] = await tx.select({ id: campSignups.id }).from(campSignups).where(and(eq(campSignups.campId, campId), eq(campSignups.profileId, profileId), ne(campSignups.status, "cancelled")));
    if (existing) throw new Error("Er allerede tilmeldt.");
    const { confirmed, waiting } = await spotCounts(tx, campId);
    const full = camp.capacity !== null && (confirmed >= camp.capacity || waiting > 0);
    const [signup] = await tx.insert(campSignups).values({ campId, profileId, signedUpByUserId: ctx.userId, status: "waitlist" }).returning({ id: campSignups.id });
    if (full) return { status: "waitlist" as const, signupId: signup.id, amountOre: 0 };
    const c = await confirmSignup(tx, camp, signup.id, profileId, ctx.userId, ctx.now);
    return { status: "confirmed" as const, signupId: signup.id, amountOre: c.amountOre };
  });
  await logAudit(db, { action: "camp.signup", clubId: camp0.clubId, actorUserId: ctx.userId, targetType: "camp", targetId: campId, detail: { profileId, status: result.status } });
  return result;
}

/** Rykker de første på ventelisten op, så længe der er ledige pladser. Giver de profiler, der fik plads. */
export async function promoteWaitlist(db: Db, campId: string, userId: string | null, now: Date, deliver?: Deliver) {
  const promoted: { profileId: string; amountOre: number }[] = [];
  const camp0 = await loadCamp(db, campId);
  await db.transaction(async (tx) => {
    const [camp] = await tx.select().from(camps).where(eq(camps.id, campId)).for("update");
    if (camp.cancelledAt) return;
    for (;;) {
      const { confirmed } = await spotCounts(tx, campId);
      if (camp.capacity !== null && confirmed >= camp.capacity) break;
      const [next] = await tx
        .select()
        .from(campSignups)
        .where(and(eq(campSignups.campId, campId), eq(campSignups.status, "waitlist")))
        .orderBy(asc(campSignups.createdAt), asc(campSignups.id))
        .limit(1);
      if (!next) break;
      const c = await confirmSignup(tx, camp, next.id, next.profileId, userId, now);
      promoted.push({ profileId: next.profileId, amountOre: c.amountOre });
    }
  });
  if (deliver) {
    for (const p of promoted) {
      await notifyUsers(db, deliver, await recipientsOfPlayers(db, [p.profileId], now), {
        kind: "waitlist",
        subject: `Der er plads på ${camp0.name}`,
        body: `Der er blevet plads på ${camp0.name}, og du er rykket op fra ventelisten.${p.amountOre > 0 ? ` Prisen er ${kr(p.amountOre)}; betal under Betaling: ${deliver.baseUrl}/betaling.` : ""}`,
        sms: `Der er plads på ${camp0.name}. Betal under Betaling i HoldLiv.`,
        url: "/betaling",
        dedupeKey: `camp:${campId}:promoted:${p.profileId}`,
      });
    }
  }
  return promoted;
}

/** Afmelder en tilmelding: personen selv eller forælderen, eller foreningens admin/kasserer. En betalt plads skal først refunderes. */
export async function cancelCampSignup(db: Db, ctx: AccessContext, signupId: string, deliver?: Deliver) {
  const [signup] = await db.select().from(campSignups).where(eq(campSignups.id, signupId));
  if (!signup || signup.status === "cancelled") throw new Error("Tilmeldingen findes ikke");
  const camp = await loadCamp(db, signup.campId);
  if (!canActAs(ctx, signup.profileId)) assertCan(ctx, { action: "finance.manage", clubId: camp.clubId });
  if (signup.chargeId) {
    const [c] = await db.select({ status: charges.status }).from(charges).where(eq(charges.id, signup.chargeId));
    if (c?.status === "paid") throw new Error("Pladsen er betalt. Kassereren skal refundere beløbet, før du kan afmelde.");
  }
  await db.transaction(async (tx) => {
    await tx.update(campSignups).set({ status: "cancelled", cancelledAt: ctx.now }).where(eq(campSignups.id, signupId));
    if (signup.chargeId) await tx.update(charges).set({ status: "cancelled" }).where(and(eq(charges.id, signup.chargeId), eq(charges.status, "open")));
  });
  await logAudit(db, { action: "camp.signup_cancelled", clubId: camp.clubId, actorUserId: ctx.userId, targetType: "camp", targetId: camp.id, detail: { profileId: signup.profileId } });
  if (signup.status === "confirmed") await promoteWaitlist(db, camp.id, ctx.userId, ctx.now, deliver);
}

/** Camps i foreninger, man (eller ens børn) er medlem af: kommende først, med pladser og ens egne tilmeldinger. */
export async function listCampsForMe(db: Db, ctx: AccessContext) {
  const people = [ctx.profileId, ...ctx.wards];
  const memberships = await db
    .select({ clubId: clubMemberships.clubId, profileId: clubMemberships.profileId })
    .from(clubMemberships)
    .where(inArray(clubMemberships.profileId, people));
  const clubIds = [...new Set(memberships.map((m) => m.clubId))];
  if (clubIds.length === 0) return [];
  const today = localDate(ctx.now);
  const rows = await db.select().from(camps).where(and(inArray(camps.clubId, clubIds), sql`${camps.endsOn} >= ${today}`)).orderBy(asc(camps.startsOn), asc(camps.name));
  const nameRows = await db.select({ id: profiles.id, firstName: profiles.firstName }).from(profiles).where(inArray(profiles.id, people));
  const names = new Map(nameRows.map((p) => [p.id, p.firstName]));
  const mine = rows.length
    ? await db.select().from(campSignups).where(and(inArray(campSignups.campId, rows.map((c) => c.id)), inArray(campSignups.profileId, people), ne(campSignups.status, "cancelled")))
    : [];
  const out = [];
  for (const camp of rows) {
    const { confirmed, waiting } = await spotCounts(db, camp.id);
    const eligible = memberships.filter((m) => m.clubId === camp.clubId).map((m) => m.profileId);
    out.push({
      ...camp,
      confirmed,
      waiting,
      free: camp.capacity === null ? null : Math.max(0, camp.capacity - confirmed),
      open: !camp.cancelledAt && today <= (camp.signupDeadline ?? camp.endsOn),
      people: eligible.map((id) => {
        const s = mine.find((x) => x.campId === camp.id && x.profileId === id);
        return { profileId: id, firstName: names.get(id) ?? "", self: id === ctx.profileId, signupId: s?.id ?? null, status: s?.status ?? null, discountPercent: s?.discountPercent ?? 0 };
      }),
    });
  }
  return out;
}

/** Foreningens camps til kassereren, med antal. */
export async function listClubCamps(db: Db, ctx: AccessContext, clubId: string) {
  assertCan(ctx, { action: "finance.manage", clubId });
  const rows = await db.select().from(camps).where(eq(camps.clubId, clubId)).orderBy(desc(camps.startsOn));
  const out = [];
  for (const camp of rows) out.push({ ...camp, ...(await spotCounts(db, camp.id)) });
  return out;
}

/** Deltagerne på en camp i rækkefølge, med opkrævningens status. */
export async function listCampSignups(db: Db, ctx: AccessContext, campId: string) {
  const camp = await loadCamp(db, campId);
  assertCan(ctx, { action: "finance.manage", clubId: camp.clubId });
  const rows = await db
    .select({ signup: campSignups, firstName: profiles.firstName, lastName: profiles.lastName, chargeStatus: charges.status, amountOre: charges.amountOre })
    .from(campSignups)
    .innerJoin(profiles, eq(profiles.id, campSignups.profileId))
    .leftJoin(charges, eq(charges.id, campSignups.chargeId))
    .where(and(eq(campSignups.campId, campId), ne(campSignups.status, "cancelled")))
    .orderBy(asc(campSignups.createdAt), asc(campSignups.id));
  return rows.map((r) => ({ ...r.signup, firstName: r.firstName, lastName: r.lastName, chargeStatus: r.chargeStatus, amountOre: r.amountOre }));
}
