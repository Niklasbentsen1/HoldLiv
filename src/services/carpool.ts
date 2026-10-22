// Samkørsel (modul "carpool"): hvem kører til en kamp, hvem mangler en lift, og hvor mødes vi.
// Alle funktioner kalder requireModule() først, så de kun virker på hold der har modulet slået til.
//
// Hvem må hvad:
//   - Enhver på holdet (spiller eller forælder) kan tilbyde pladser. Føreren er altid login'ets egen profil
//     og skal være voksen.
//   - Man sætter sit barn (eller sig selv) på en bil eller beder om en lift. Føreren og trænere/admin kan
//     også sætte spillere på og tage dem af.
//   - Telefonnumre: førerens nummer vises for passagererne og deres forældre, og forældrenes numre
//     vises for føreren. Trænere og admin ser alle.
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  carpoolOffers,
  carpoolPassengers,
  carpoolRequests,
  events,
  guardianships,
  profiles,
  teamMembers,
} from "../db/schema";
import { can, canActAs, isMinor, type AccessContext } from "../auth/permissions";
import { requireModule } from "./modules";

export const MAX_SEATS = 8;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function loadEvent(db: Pick<Db, "select">, eventId: string) {
  const [e] = await db
    .select({ id: events.id, teamId: events.teamId, clubId: events.clubId, startsAt: events.startsAt, cancelledAt: events.cancelledAt })
    .from(events)
    .where(eq(events.id, eventId));
  if (!e) throw new Error("Aktiviteten findes ikke");
  return e;
}

/** Samkørsel kan kun aftales for aktiviteter der ikke er aflyst og ikke er begyndt. */
function assertOpen(ctx: AccessContext, e: { startsAt: Date; cancelledAt: Date | null }) {
  if (e.cancelledAt) throw new Error("Aktiviteten er aflyst.");
  if (e.startsAt.getTime() <= ctx.now.getTime()) throw new Error("Aktiviteten er allerede begyndt.");
}

async function loadOffer(db: Pick<Db, "select">, offerId: string) {
  const [o] = await db.select().from(carpoolOffers).where(eq(carpoolOffers.id, offerId));
  if (!o) throw new Error("Samkørslen findes ikke");
  return o;
}

async function assertTeamPlayer(db: Pick<Db, "select">, teamId: string, profileId: string) {
  const [row] = await db
    .select({ id: teamMembers.profileId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.profileId, profileId), eq(teamMembers.role, "player")));
  if (!row) throw new Error("Spilleren er ikke på holdet.");
}

const leads = (ctx: AccessContext, e: { teamId: string; clubId: string }) =>
  can(ctx, { action: "team.manage", team: { teamId: e.teamId, clubId: e.clubId } });

export interface OfferInput {
  seats: number;
  meetingPoint: string;
  departsAt?: Date | null;
  note?: string | null;
}

function cleanOffer(input: OfferInput) {
  const meetingPoint = input.meetingPoint.trim();
  if (!meetingPoint) throw new Error("Skriv hvor I mødes.");
  if (!Number.isInteger(input.seats) || input.seats < 1 || input.seats > MAX_SEATS) {
    throw new Error(`Antal pladser skal være et helt tal fra 1 til ${MAX_SEATS}.`);
  }
  return { seats: input.seats, meetingPoint, departsAt: input.departsAt ?? null, note: input.note?.trim() || null };
}

/** Tilbyd pladser. Føreren er login'ets egen profil; én bil pr. fører pr. aktivitet. */
export async function offerRide(db: Db, ctx: AccessContext, eventId: string, input: OfferInput) {
  const e = await loadEvent(db, eventId);
  await requireModule(db, ctx, e.teamId, "carpool");
  assertOpen(ctx, e);
  const data = cleanOffer(input);
  const [me] = await db.select({ birthDate: profiles.birthDate }).from(profiles).where(eq(profiles.id, ctx.profileId));
  if (me.birthDate && isMinor(me.birthDate, ctx.now)) throw new Error("Kun voksne kan tilbyde at køre.");
  const [existing] = await db
    .select({ id: carpoolOffers.id })
    .from(carpoolOffers)
    .where(and(eq(carpoolOffers.eventId, eventId), eq(carpoolOffers.driverProfileId, ctx.profileId)));
  if (existing) throw new Error("Du kører allerede til denne aktivitet. Ret din samkørsel i stedet.");
  const [offer] = await db
    .insert(carpoolOffers)
    .values({ ...data, eventId, driverProfileId: ctx.profileId, createdByUserId: ctx.userId })
    .returning();
  return offer;
}

/** Føreren (eller trænere/admin) retter bilen. Pladser kan ikke sættes under antallet af passagerer. */
export async function updateOffer(db: Db, ctx: AccessContext, offerId: string, input: OfferInput) {
  const offer = await loadOffer(db, offerId);
  const e = await loadEvent(db, offer.eventId);
  await requireModule(db, ctx, e.teamId, "carpool");
  if (offer.driverProfileId !== ctx.profileId && !leads(ctx, e)) throw new Error("Det er ikke din samkørsel.");
  assertOpen(ctx, e);
  const data = cleanOffer(input);
  return db.transaction(async (tx) => {
    await tx.select().from(carpoolOffers).where(eq(carpoolOffers.id, offerId)).for("update");
    const taken = await tx.select({ p: carpoolPassengers.profileId }).from(carpoolPassengers).where(eq(carpoolPassengers.offerId, offerId));
    if (data.seats < taken.length) throw new Error(`Der sidder allerede ${taken.length} i bilen. Tag nogen af først.`);
    const [o] = await tx.update(carpoolOffers).set(data).where(eq(carpoolOffers.id, offerId)).returning();
    return o;
  });
}

/** Slet bilen. Passagererne havner ikke i "mangler lift" automatisk; de skal selv bede om en ny. */
export async function cancelOffer(db: Db, ctx: AccessContext, offerId: string) {
  const offer = await loadOffer(db, offerId);
  const e = await loadEvent(db, offer.eventId);
  await requireModule(db, ctx, e.teamId, "carpool");
  if (offer.driverProfileId !== ctx.profileId && !leads(ctx, e)) throw new Error("Det er ikke din samkørsel.");
  await db.delete(carpoolOffers).where(eq(carpoolOffers.id, offerId));
}

/** "Vi mangler en lift" for en spiller man er forælder til (eller en selv). */
export async function requestRide(db: Db, ctx: AccessContext, eventId: string, profileId: string, note?: string | null) {
  const e = await loadEvent(db, eventId);
  await requireModule(db, ctx, e.teamId, "carpool");
  if (!canActAs(ctx, profileId) && !leads(ctx, e)) throw new Error("Du må ikke bede om lift for den spiller.");
  assertOpen(ctx, e);
  await assertTeamPlayer(db, e.teamId, profileId);
  await db.transaction(async (tx) => {
    const [seated] = await tx
      .select({ o: carpoolPassengers.offerId })
      .from(carpoolPassengers)
      .where(and(eq(carpoolPassengers.eventId, eventId), eq(carpoolPassengers.profileId, profileId)));
    if (seated) throw new Error("Spilleren har allerede en plads i en bil.");
    await tx
      .insert(carpoolRequests)
      .values({ eventId, profileId, note: note?.trim() || null, requestedByUserId: ctx.userId })
      .onConflictDoUpdate({ target: [carpoolRequests.eventId, carpoolRequests.profileId], set: { note: note?.trim() || null } });
  });
}

export async function cancelRideRequest(db: Db, ctx: AccessContext, eventId: string, profileId: string) {
  const e = await loadEvent(db, eventId);
  await requireModule(db, ctx, e.teamId, "carpool");
  if (!canActAs(ctx, profileId) && !leads(ctx, e)) throw new Error("Du må ikke ændre den spillers lift.");
  await db.delete(carpoolRequests).where(and(eq(carpoolRequests.eventId, eventId), eq(carpoolRequests.profileId, profileId)));
}

/**
 * Sæt en spiller på en bil. Forælderen gør det for sit barn, trænere/admin kan sætte alle på, og føreren kan
 * tage en spiller med på sin egen bil, men kun hvis spilleren har bedt om en lift. Pladserne tælles i en transaktion med lås på bilen, så to forældre der
 * trykker samtidig ikke kan overbooke. Sidder spilleren i en anden bil til samme aktivitet, flyttes vedkommende.
 */
export async function bookSeat(db: Db, ctx: AccessContext, offerId: string, profileId: string) {
  const offer = await loadOffer(db, offerId);
  const e = await loadEvent(db, offer.eventId);
  await requireModule(db, ctx, e.teamId, "carpool");
  if (!canActAs(ctx, profileId) && offer.driverProfileId !== ctx.profileId && !leads(ctx, e)) {
    throw new Error("Du må ikke sætte den spiller på bilen.");
  }
  assertOpen(ctx, e);
  await assertTeamPlayer(db, e.teamId, profileId);
  await db.transaction(async (tx: Tx) => {
    const [locked] = await tx.select().from(carpoolOffers).where(eq(carpoolOffers.id, offerId)).for("update");
    if (!locked) throw new Error("Samkørslen findes ikke længere.");
    const seated = await tx.select({ p: carpoolPassengers.profileId, offerId: carpoolPassengers.offerId }).from(carpoolPassengers).where(eq(carpoolPassengers.eventId, e.id));
    if (seated.some((s) => s.p === profileId && s.offerId === offerId)) return;
    // En fører der hverken er spillerens forælder eller træner/admin må kun tage spillere med fra "mangler en lift".
    // Hun må aldrig flytte en spiller, som forælderen allerede har sat på en anden bil.
    if (!canActAs(ctx, profileId) && !leads(ctx, e)) {
      const [asked] = await tx
        .select({ p: carpoolRequests.profileId })
        .from(carpoolRequests)
        .where(and(eq(carpoolRequests.eventId, e.id), eq(carpoolRequests.profileId, profileId)));
      if (!asked || seated.some((s) => s.p === profileId)) throw new Error("Spilleren har ikke bedt om en lift.");
    }
    if (seated.filter((s) => s.offerId === offerId).length >= locked.seats) throw new Error("Bilen er fuld.");
    await tx.delete(carpoolPassengers).where(and(eq(carpoolPassengers.eventId, e.id), eq(carpoolPassengers.profileId, profileId)));
    await tx.insert(carpoolPassengers).values({ offerId, eventId: e.id, profileId, addedByUserId: ctx.userId });
    await tx.delete(carpoolRequests).where(and(eq(carpoolRequests.eventId, e.id), eq(carpoolRequests.profileId, profileId)));
  });
}

/** Tag en spiller af bilen. Samme regler som bookSeat. */
export async function leaveSeat(db: Db, ctx: AccessContext, offerId: string, profileId: string) {
  const offer = await loadOffer(db, offerId);
  const e = await loadEvent(db, offer.eventId);
  await requireModule(db, ctx, e.teamId, "carpool");
  if (!canActAs(ctx, profileId) && offer.driverProfileId !== ctx.profileId && !leads(ctx, e)) {
    throw new Error("Du må ikke tage den spiller af bilen.");
  }
  await db.delete(carpoolPassengers).where(and(eq(carpoolPassengers.offerId, offerId), eq(carpoolPassengers.profileId, profileId)));
}

/** Samkørslen til én aktivitet: biler, passagerer og dem der mangler en lift. */
export async function getEventCarpool(db: Db, ctx: AccessContext, eventId: string) {
  const e = await loadEvent(db, eventId);
  await requireModule(db, ctx, e.teamId, "carpool");
  const lead = leads(ctx, e);

  const [offers, passengers, requests] = await Promise.all([
    db
      .select({
        id: carpoolOffers.id,
        driverProfileId: carpoolOffers.driverProfileId,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        phone: profiles.phone,
        seats: carpoolOffers.seats,
        meetingPoint: carpoolOffers.meetingPoint,
        departsAt: carpoolOffers.departsAt,
        note: carpoolOffers.note,
      })
      .from(carpoolOffers)
      .innerJoin(profiles, eq(profiles.id, carpoolOffers.driverProfileId))
      .where(eq(carpoolOffers.eventId, eventId))
      .orderBy(asc(carpoolOffers.createdAt)),
    db
      .select({ offerId: carpoolPassengers.offerId, profileId: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName })
      .from(carpoolPassengers)
      .innerJoin(profiles, eq(profiles.id, carpoolPassengers.profileId))
      .where(eq(carpoolPassengers.eventId, eventId))
      .orderBy(asc(profiles.firstName)),
    db
      .select({ profileId: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, note: carpoolRequests.note })
      .from(carpoolRequests)
      .innerJoin(profiles, eq(profiles.id, carpoolRequests.profileId))
      .where(eq(carpoolRequests.eventId, eventId))
      .orderBy(asc(carpoolRequests.createdAt)),
  ]);

  const guardianRows = passengers.length
    ? await db
        .select({ childId: guardianships.childProfileId, firstName: profiles.firstName, phone: profiles.phone })
        .from(guardianships)
        .innerJoin(profiles, eq(profiles.id, guardianships.guardianProfileId))
        .where(inArray(guardianships.childProfileId, passengers.map((p) => p.profileId)))
    : [];

  // Spillerne man selv kan handle for, og som endnu ikke har en plads.
  const roster = await db
    .select({ id: profiles.id, firstName: profiles.firstName })
    .from(teamMembers)
    .innerJoin(profiles, eq(profiles.id, teamMembers.profileId))
    .where(and(eq(teamMembers.teamId, e.teamId), eq(teamMembers.role, "player")))
    .orderBy(asc(profiles.firstName));
  const seatedIds = new Set(passengers.map((p) => p.profileId));
  const requestedIds = new Set(requests.map((r) => r.profileId));
  const myPlayers = roster.filter((p) => canActAs(ctx, p.id));
  const open = ctx.now.getTime() < e.startsAt.getTime() && !e.cancelledAt;

  return {
    eventId,
    open,
    canOffer: open && !offers.some((o) => o.driverProfileId === ctx.profileId),
    /** Egne spillere der hverken har en plads eller har bedt om lift. */
    canRequestFor: open ? myPlayers.filter((p) => !seatedIds.has(p.id) && !requestedIds.has(p.id)) : [],
    offers: offers.map((o) => {
      const own = o.driverProfileId === ctx.profileId;
      const riders = passengers.filter((p) => p.offerId === o.id);
      const myRiderHere = riders.some((p) => canActAs(ctx, p.profileId));
      const seeDriverPhone = lead || own || myRiderHere;
      return {
        id: o.id,
        driverName: `${o.firstName} ${o.lastName}`,
        driverPhone: seeDriverPhone ? o.phone : null,
        seats: o.seats,
        free: Math.max(0, o.seats - riders.length),
        meetingPoint: o.meetingPoint,
        departsAt: o.departsAt,
        note: o.note,
        mine: own,
        canManage: open && (own || lead),
        passengers: riders.map((p) => ({
          profileId: p.profileId,
          name: `${p.firstName} ${p.lastName}`,
          mine: canActAs(ctx, p.profileId),
          canRemove: open && (canActAs(ctx, p.profileId) || own || lead),
          // Forældrenes numre vises for føreren og trænerne, så de kan ringes op ved afhentning.
          guardianPhones: own || lead ? guardianRows.filter((g) => g.childId === p.profileId && g.phone).map((g) => `${g.firstName}: ${g.phone}`) : [],
        })),
        /** Egne spillere uden plads, som kan sættes på denne bil. */
        bookable: open && o.seats > riders.length ? myPlayers.filter((p) => !seatedIds.has(p.id)).map((p) => ({ id: p.id, firstName: p.firstName })) : [],
        /** Egne spillere der sidder i en anden bil og kan flyttes hertil. */
        movable: open && o.seats > riders.length ? myPlayers.filter((p) => seatedIds.has(p.id) && !riders.some((r) => r.profileId === p.id)).map((p) => ({ id: p.id, firstName: p.firstName })) : [],
      };
    }),
    requests: requests.map((r) => ({
      profileId: r.profileId,
      name: `${r.firstName} ${r.lastName}`,
      note: r.note,
      mine: canActAs(ctx, r.profileId),
      canCancel: open && (canActAs(ctx, r.profileId) || lead),
      /** Biler med ledig plads, som man selv må tage spilleren med i: egen bil som fører, alle biler som træner/admin. */
      takeIn: open
        ? offers
            .filter((o) => (o.driverProfileId === ctx.profileId || lead) && o.seats > passengers.filter((p) => p.offerId === o.id).length)
            .map((o) => ({ offerId: o.id, driverName: `${o.firstName} ${o.lastName}` }))
        : [],
    })),
  };
}

/** Holdets kommende aktiviteter (ikke aflyste), som samkørslen kan aftales til. */
export async function listCarpoolEvents(db: Db, ctx: AccessContext, teamId: string, limit = 10) {
  await requireModule(db, ctx, teamId, "carpool");
  return db
    .select({ id: events.id, title: events.title, type: events.type, startsAt: events.startsAt, location: events.location })
    .from(events)
    .where(and(eq(events.teamId, teamId), gt(events.startsAt, ctx.now), isNull(events.cancelledAt)))
    .orderBy(asc(events.startsAt))
    .limit(limit);
}
