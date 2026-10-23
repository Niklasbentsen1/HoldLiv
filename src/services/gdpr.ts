// GDPR: samtykker, dataudtræk og sletning af egne data.
//
// Sletning anonymiserer personen i stedet for at fjerne profilrækken: opkrævninger og betalinger skal gemmes
// efter bogføringsloven, og de hænger på profilen. Alt der identificerer personen fjernes (navn, kontaktoplysninger,
// fødselsdato, login, beskeder, opslag, svar, tilmeldinger). Slettede personer vises som "Slettet medlem".
import { and, eq, inArray, isNotNull, isNull, ne, not, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  auditLog,
  campSignups,
  bookings,
  childCertificates,
  contracts,
  shiftSignups,
  carpoolOffers,
  carpoolPassengers,
  carpoolRequests,
  chatMessages,
  charges,
  clubMemberships,
  clubRoles,
  clubs,
  consents,
  eventResponses,
  expenseClaims,
  events,
  fines,
  guardianships,
  loginTokens,
  matchEvents,
  matchPlayers,
  notificationPrefs,
  payments,
  posts,
  profiles,
  savedCards,
  teamMembers,
  teamFundEntries,
  pollOptions,
  pollVotes,
  polls,
  teamTasks,
  volunteerShifts,
  teams,
  users,
} from "../db/schema";
import { canActAs, ForbiddenError, type AccessContext } from "../auth/permissions";
import { logAudit } from "./audit";
import type { PaymentProvider } from "../lib/payments";

/** Versionen af privatlivspolitikken. Hæves, når teksten ændres væsentligt. */
export const PRIVACY_VERSION = "2026-10-udkast";

export const CONSENT_KINDS = {
  privacy: { label: "Privatlivspolitik", description: "Jeg har læst og accepterer, hvordan HoldLiv og foreningen behandler oplysninger.", required: true },
  ai_service: { label: "AI-hjælp med mine oplysninger", description: "Jeg vil gerne have svar fra AI-medlemsservicen. Mine og mine børns oplysninger om aktiviteter og betalinger sendes (uden navne) til AI-udbyderen for at lave svaret.", required: false },
  photos: { label: "Billeder og video", description: "Foreningen må bruge billeder og video, hvor personen kan genkendes, fx på hjemmesiden og sociale medier.", required: false },
} as const;
export type ConsentKind = keyof typeof CONSENT_KINDS;

function assertActs(ctx: AccessContext, profileId: string) {
  if (!canActAs(ctx, profileId)) throw new ForbiddenError("profile.edit");
}

export async function listConsents(db: Db, ctx: AccessContext, profileId: string) {
  assertActs(ctx, profileId);
  const rows = await db.select().from(consents).where(and(eq(consents.profileId, profileId), isNull(consents.withdrawnAt)));
  return (Object.keys(CONSENT_KINDS) as ConsentKind[]).map((kind) => {
    const c = rows.find((r) => r.kind === kind);
    return { kind, ...CONSENT_KINDS[kind], granted: !!c, version: c?.version ?? null, givenAt: c?.givenAt ?? null };
  });
}

/** Ved oprettelse: personen har sat kryds ved privatlivspolitikken. */
export async function recordPrivacyConsent(db: Db, userId: string, profileId: string, now = new Date()) {
  await db.insert(consents).values({ profileId, kind: "privacy", version: PRIVACY_VERSION, givenByUserId: userId, givenAt: now }).onConflictDoNothing();
}

export async function hasConsent(db: Db, profileId: string, kind: ConsentKind) {
  const [c] = await db.select({ id: consents.id }).from(consents).where(and(eq(consents.profileId, profileId), eq(consents.kind, kind), isNull(consents.withdrawnAt)));
  return !!c;
}

/** Giv eller træk et samtykke. Historikken bevares: et trukket samtykke får withdrawn_at. */
export async function setConsent(db: Db, ctx: AccessContext, profileId: string, kind: ConsentKind, granted: boolean) {
  assertActs(ctx, profileId);
  if (!(kind in CONSENT_KINDS)) throw new Error("Ukendt samtykke.");
  if (!granted && CONSENT_KINDS[kind].required) throw new Error("Privatlivspolitikken kan ikke trækkes tilbage, uden at du sletter din konto.");
  await db.transaction(async (tx) => {
    if (granted) {
      await tx.insert(consents).values({ profileId, kind, version: PRIVACY_VERSION, givenByUserId: ctx.userId, givenAt: ctx.now }).onConflictDoNothing();
    } else {
      await tx.update(consents).set({ withdrawnAt: ctx.now }).where(and(eq(consents.profileId, profileId), eq(consents.kind, kind), isNull(consents.withdrawnAt)));
    }
  });
}

async function clubsOf(db: Db, profileIds: string[]) {
  const rows = await db.selectDistinct({ clubId: clubMemberships.clubId }).from(clubMemberships).where(inArray(clubMemberships.profileId, profileIds));
  return rows.map((r) => r.clubId);
}

// --- Dataudtræk ---

async function exportProfile(db: Db, profileId: string) {
  const [profile] = await db
    .select({ firstName: profiles.firstName, lastName: profiles.lastName, birthDate: profiles.birthDate, email: profiles.email, phone: profiles.phone, createdAt: profiles.createdAt })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  const [memberships, roles, teamRows, responses, myCharges, offers, rides, requests, tasks, myFines, matchLineups, matchEventRows, written, myPosts, myConsents, guardians, myShifts, myContracts, myCertificates, myFundDeposits, myPollVotes] = await Promise.all([
    db
      .select({ club: clubs.name, status: clubMemberships.status, joinedAt: clubMemberships.joinedAt, leftAt: clubMemberships.leftAt, exempt: clubMemberships.exempt })
      .from(clubMemberships)
      .innerJoin(clubs, eq(clubs.id, clubMemberships.clubId))
      .where(eq(clubMemberships.profileId, profileId)),
    db.select({ club: clubs.name, role: clubRoles.role, title: clubRoles.title }).from(clubRoles).innerJoin(clubs, eq(clubs.id, clubRoles.clubId)).where(eq(clubRoles.profileId, profileId)),
    db.select({ team: teams.name, season: teams.season, role: teamMembers.role, since: teamMembers.createdAt }).from(teamMembers).innerJoin(teams, eq(teams.id, teamMembers.teamId)).where(eq(teamMembers.profileId, profileId)),
    db
      .select({ event: events.title, startsAt: events.startsAt, status: eventResponses.status, comment: eventResponses.comment, respondedAt: eventResponses.respondedAt })
      .from(eventResponses)
      .innerJoin(events, eq(events.id, eventResponses.eventId))
      .where(eq(eventResponses.profileId, profileId)),
    db
      .select({ id: charges.id, description: charges.description, amountOre: charges.amountOre, dueDate: charges.dueDate, status: charges.status, paidAt: charges.paidAt })
      .from(charges)
      .where(eq(charges.profileId, profileId)),
    db.select({ seats: carpoolOffers.seats, meetingPoint: carpoolOffers.meetingPoint, departsAt: carpoolOffers.departsAt, note: carpoolOffers.note }).from(carpoolOffers).where(eq(carpoolOffers.driverProfileId, profileId)),
    db.select({ eventId: carpoolPassengers.eventId, since: carpoolPassengers.createdAt }).from(carpoolPassengers).where(eq(carpoolPassengers.profileId, profileId)),
    db.select({ eventId: carpoolRequests.eventId, note: carpoolRequests.note, at: carpoolRequests.createdAt }).from(carpoolRequests).where(eq(carpoolRequests.profileId, profileId)),
    db.select({ title: teamTasks.title, kind: teamTasks.kind, assignedAt: teamTasks.assignedAt, doneAt: teamTasks.doneAt }).from(teamTasks).where(eq(teamTasks.assigneeProfileId, profileId)),
    db.select({ description: fines.description, amountOre: fines.amountOre, createdAt: fines.createdAt, paidAt: fines.paidAt }).from(fines).where(eq(fines.profileId, profileId)),
    db
      .select({ match: events.title, startsAt: events.startsAt, slot: matchPlayers.slot, position: matchPlayers.position, minutes: matchPlayers.minutes })
      .from(matchPlayers)
      .innerJoin(events, eq(events.id, matchPlayers.eventId))
      .where(eq(matchPlayers.profileId, profileId)),
    db
      .select({ match: events.title, kind: matchEvents.kind, minute: matchEvents.minute, asAssist: sql<boolean>`${matchEvents.assistProfileId} = ${profileId}` })
      .from(matchEvents)
      .innerJoin(events, eq(events.id, matchEvents.eventId))
      .where(or(eq(matchEvents.profileId, profileId), eq(matchEvents.assistProfileId, profileId))),
    db.select({ body: chatMessages.body, at: chatMessages.createdAt, deleted: chatMessages.deletedAt }).from(chatMessages).where(eq(chatMessages.authorProfileId, profileId)),
    db.select({ kind: posts.kind, title: posts.title, body: posts.body, at: posts.createdAt }).from(posts).where(and(eq(posts.authorProfileId, profileId), isNull(posts.deletedAt))),
    db.select({ kind: consents.kind, version: consents.version, givenAt: consents.givenAt, withdrawnAt: consents.withdrawnAt }).from(consents).where(eq(consents.profileId, profileId)),
    db
      .select({ firstName: profiles.firstName, lastName: profiles.lastName, relation: guardianships.relation })
      .from(guardianships)
      .innerJoin(profiles, eq(profiles.id, guardianships.guardianProfileId))
      .where(eq(guardianships.childProfileId, profileId)),
    db
      .select({ shift: volunteerShifts.title, startsAt: volunteerShifts.startsAt, signedUpAt: shiftSignups.createdAt, cancelledAt: shiftSignups.cancelledAt })
      .from(shiftSignups)
      .innerJoin(volunteerShifts, eq(volunteerShifts.id, shiftSignups.shiftId))
      .where(eq(shiftSignups.profileId, profileId)),
    db
      .select({ title: contracts.title, kind: contracts.kind, status: contracts.status, startsOn: contracts.startsOn, endsOn: contracts.endsOn, monthlyAmountOre: contracts.monthlyAmountOre, signedAt: contracts.signedAt, signedName: contracts.signedName, body: contracts.body })
      .from(contracts)
      .where(and(eq(contracts.profileId, profileId), ne(contracts.status, "draft"))),
    db
      .select({ status: childCertificates.status, reason: childCertificates.reason, consentAt: childCertificates.consentAt, requestedAt: childCertificates.requestedAt, decidedAt: childCertificates.decidedAt, issuedOn: childCertificates.issuedOn, expiresOn: childCertificates.expiresOn })
      .from(childCertificates)
      .where(eq(childCertificates.profileId, profileId)),
    db
      .select({ description: teamFundEntries.description, amountOre: teamFundEntries.amountOre, entryDate: teamFundEntries.entryDate })
      .from(teamFundEntries)
      .where(eq(teamFundEntries.profileId, profileId)),
    db
      .select({ question: polls.question, answer: pollOptions.label, votedAt: pollVotes.createdAt })
      .from(pollVotes)
      .innerJoin(polls, eq(polls.id, pollVotes.pollId))
      .innerJoin(pollOptions, eq(pollOptions.id, pollVotes.optionId))
      .where(eq(pollVotes.profileId, profileId)),
  ]);
  const paymentRows = myCharges.length
    ? await db
        .select({ chargeId: payments.chargeId, provider: payments.provider, amountOre: payments.amountOre, status: payments.status, completedAt: payments.completedAt })
        .from(payments)
        .where(inArray(payments.chargeId, myCharges.map((c) => c.id)))
    : [];
  return {
    profile,
    guardians,
    clubMemberships: memberships,
    clubRoles: roles,
    teams: teamRows,
    eventResponses: responses,
    charges: myCharges.map(({ id, ...c }) => ({ ...c, payments: paymentRows.filter((p) => p.chargeId === id).map(({ chargeId, ...p }) => p) })),
    carpool: { offers, passenger: rides, requests },
    tasks,
    fines: myFines,
    matches: { lineups: matchLineups, events: matchEventRows },
    chatMessages: written,
    posts: myPosts,
    consents: myConsents,
    volunteerShifts: myShifts,
    contracts: myContracts,
    childCertificates: myCertificates,
    teamFundDeposits: myFundDeposits,
    pollVotes: myPollVotes,
  };
}

/** Alt, HoldLiv har om personen selv og om børn personen er værge for. Til download som JSON. */
export async function exportMyData(db: Db, ctx: AccessContext) {
  const [account] = await db.select({ email: users.email, createdAt: users.createdAt, twoFactor: users.totpEnabledAt }).from(users).where(eq(users.id, ctx.userId));
  const prefs = await db.select({ kind: notificationPrefs.kind, channel: notificationPrefs.channel, enabled: notificationPrefs.enabled }).from(notificationPrefs).where(eq(notificationPrefs.userId, ctx.userId));
  const activity = await db
    .select({ at: auditLog.at, action: auditLog.action, targetType: auditLog.targetType })
    .from(auditLog)
    .where(eq(auditLog.actorUserId, ctx.userId));
  const wardIds = [...ctx.wards];
  const people = [];
  for (const id of [ctx.profileId, ...wardIds]) people.push({ self: id === ctx.profileId, ...(await exportProfile(db, id)) });
  const ids = [ctx.profileId, ...wardIds];
  for (const clubId of await clubsOf(db, ids)) await logAudit(db, { action: "gdpr.exported", clubId, actorUserId: ctx.userId });
  return { generatedAt: ctx.now.toISOString(), account: { ...account, notificationPreferences: prefs, activityLog: activity }, people };
}

// --- Sletning ---

export interface DeletionPlan {
  /** Personer der anonymiseres: en selv og børn hvor man er eneste værge. */
  profileIds: string[];
  blockers: string[];
}

async function planDeletion(db: Db, ctx: AccessContext): Promise<DeletionPlan> {
  const blockers: string[] = [];
  // Børn med en anden værge bliver; børn hvor man er den eneste, slettes med.
  const kids = await db
    .select({ childId: guardianships.childProfileId, guardians: sql<number>`(select count(*)::int from guardianships g2 where g2.child_profile_id = guardianships.child_profile_id)` })
    .from(guardianships)
    .where(eq(guardianships.guardianProfileId, ctx.profileId));
  // Kun mindreårige: et voksent barn er sin egen person, selv om man stadig står som værge.
  const sole = kids.filter((k) => k.guardians <= 1 && ctx.wards.has(k.childId)).map((k) => k.childId);
  const profileIds = [ctx.profileId, ...sole];

  const soleAdmin = await db
    .select({ clubId: clubRoles.clubId, club: clubs.name })
    .from(clubRoles)
    .innerJoin(clubs, eq(clubs.id, clubRoles.clubId))
    .where(
      and(
        eq(clubRoles.profileId, ctx.profileId),
        eq(clubRoles.role, "admin"),
        sql`(select count(*) from club_roles r2 where r2.club_id = club_roles.club_id and r2.role = 'admin') <= 1`,
      ),
    );
  for (const a of soleAdmin) blockers.push(`Du er den eneste admin i ${a.club}. Gør en anden til admin først.`);

  const [{ open }] = await db
    .select({ open: sql<number>`count(*)::int` })
    .from(charges)
    .where(and(inArray(charges.profileId, profileIds), eq(charges.status, "open")));
  if (open > 0) blockers.push(`Der er ${open} ubetalte opkrævninger. Betal dem, eller bed foreningen annullere dem, før du sletter.`);
  return { profileIds, blockers };
}

export async function previewDeletion(db: Db, ctx: AccessContext) {
  const plan = await planDeletion(db, ctx);
  const names = await db.select({ id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, userId: profiles.userId }).from(profiles).where(inArray(profiles.id, plan.profileIds));
  // ownLogin: et barn med eget login mister også sit login.
  return { blockers: plan.blockers, people: names.map((n) => ({ id: n.id, name: `${n.firstName} ${n.lastName}`, self: n.id === ctx.profileId, ownLogin: n.id !== ctx.profileId && !!n.userId })) };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Anonymiserer personerne og sletter deres eventuelle login. */
async function anonymize(tx: Tx, profileIds: string[], now: Date) {
  const logins = (await tx.select({ userId: profiles.userId }).from(profiles).where(inArray(profiles.id, profileIds))).map((p) => p.userId).filter((id): id is string => !!id);
  const emails = logins.length ? (await tx.select({ email: users.email }).from(users).where(inArray(users.id, logins))).map((u) => u.email) : [];
  await tx.delete(eventResponses).where(inArray(eventResponses.profileId, profileIds));
  await tx.delete(carpoolPassengers).where(inArray(carpoolPassengers.profileId, profileIds));
  await tx.delete(carpoolRequests).where(inArray(carpoolRequests.profileId, profileIds));
  await tx.delete(carpoolOffers).where(inArray(carpoolOffers.driverProfileId, profileIds));
  await tx.delete(chatMessages).where(inArray(chatMessages.authorProfileId, profileIds));
  await tx.delete(posts).where(inArray(posts.authorProfileId, profileIds));
  await tx.delete(teamMembers).where(inArray(teamMembers.profileId, profileIds));
  await tx.delete(clubMemberships).where(inArray(clubMemberships.profileId, profileIds));
  await tx.delete(clubRoles).where(inArray(clubRoles.profileId, profileIds));
  await tx.delete(consents).where(inArray(consents.profileId, profileIds));
  await tx.delete(guardianships).where(inArray(guardianships.childProfileId, profileIds));
  await tx.delete(guardianships).where(inArray(guardianships.guardianProfileId, profileIds));
  await tx.update(teamTasks).set({ assigneeProfileId: null }).where(inArray(teamTasks.assigneeProfileId, profileIds));
  await tx.delete(campSignups).where(inArray(campSignups.profileId, profileIds));
  await tx.delete(shiftSignups).where(inArray(shiftSignups.profileId, profileIds));
  await tx.delete(childCertificates).where(inArray(childCertificates.profileId, profileIds));
  // Kontrakter indeholder personens navn og aftalevilkår. Foreningen kan hente dem frem, før personen slettes.
  // Underskrevne kontrakter med et beløb kan indgå i bogføringen og gemmes derfor uden tekst; resten slettes.
  const keep = and(inArray(contracts.profileId, profileIds), eq(contracts.status, "signed"), isNotNull(contracts.monthlyAmountOre));
  await tx.update(contracts).set({ body: "Slettet", title: "Slettet kontrakt", signedName: null, declinedReason: null }).where(keep);
  await tx.delete(contracts).where(and(inArray(contracts.profileId, profileIds), not(keep!)));
  if (logins.length) await tx.update(contracts).set({ signedName: null }).where(inArray(contracts.signedByUserId, logins));
  // Holdets bookinger ligger på trænerens profil, men tilhører holdet; kun personlige bookinger slettes.
  await tx.delete(bookings).where(and(inArray(bookings.profileId, profileIds), isNull(bookings.teamId)));
  // Krav, der ikke blev godkendt, slettes med kvitteringer. Godkendte og betalte gemmes (bogføringsloven) og er uden navn, når profilen anonymiseres.
  await tx.delete(expenseClaims).where(and(inArray(expenseClaims.profileId, profileIds), inArray(expenseClaims.status, ["submitted", "rejected", "cancelled"])));
  // Bødernes tekst kan nævne personen.
  // Kampe: opstilling og kort slettes. Mål bliver stående i resultatet som mål uden navn.
  await tx.delete(matchPlayers).where(inArray(matchPlayers.profileId, profileIds));
  await tx.delete(matchEvents).where(and(inArray(matchEvents.profileId, profileIds), inArray(matchEvents.kind, ["yellow", "red"])));
  await tx.update(matchEvents).set({ profileId: null }).where(inArray(matchEvents.profileId, profileIds));
  await tx.update(matchEvents).set({ assistProfileId: null }).where(inArray(matchEvents.assistProfileId, profileIds));
  await tx.delete(pollVotes).where(inArray(pollVotes.profileId, profileIds));
  await tx.update(teamFundEntries).set({ profileId: null, description: "Indbetaling (slettet medlem)" }).where(inArray(teamFundEntries.profileId, profileIds));
  await tx.update(fines).set({ description: "Slettet" }).where(inArray(fines.profileId, profileIds));
  await tx
    .update(profiles)
    .set({ firstName: "Slettet", lastName: "medlem", birthDate: null, email: null, phone: null, userId: null, createdByUserId: null, deletedAt: now })
    .where(inArray(profiles.id, profileIds));
  if (emails.length) await tx.delete(loginTokens).where(inArray(loginTokens.email, emails));
  // Sessioner, indstillinger, push, kalenderlink, nødkoder m.m. følger med (cascade). Loggen beholder rækken uden afsender.
  if (logins.length) await tx.delete(users).where(inArray(users.id, logins));
}

/**
 * Sletter ens egen konto: login, beskeder, opslag, svar og tilmeldinger fjernes, og profilen anonymiseres. Opkrævninger
 * og betalinger gemmes uden navn. Kræver, at man skriver sin e-mail som bekræftelse. Børn, hvor man er eneste værge, slettes med.
 */
export async function deleteMyAccount(db: Db, ctx: AccessContext, confirmEmail: string, provider?: PaymentProvider) {
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, ctx.userId));
  if (!u || confirmEmail.trim().toLowerCase() !== u.email) throw new Error("Skriv din e-mailadresse for at bekræfte.");
  const plan = await planDeletion(db, ctx);
  if (plan.blockers.length > 0) throw new Error(plan.blockers.join(" "));
  const clubIds = await clubsOf(db, plan.profileIds);
  // Gemte kort frakobles hos udbyderen, før kontoen slettes, så der ikke kan trækkes mere.
  const cards = await db
    .select({ id: savedCards.id, customerId: savedCards.customerId, paymentMethodId: savedCards.paymentMethodId, brand: savedCards.brand, last4: savedCards.last4, account: clubs.stripeAccountId })
    .from(savedCards)
    .innerJoin(clubs, eq(clubs.id, savedCards.clubId))
    .where(and(inArray(savedCards.payerProfileId, plan.profileIds), isNull(savedCards.removedAt)));
  for (const k of cards) {
    try {
      await provider?.removeCard(k, k.account);
    } catch (e) {
      console.error("Kortet kunne ikke fjernes hos udbyderen", e);
    }
  }
  await db.transaction(async (tx) => {
    if (cards.length) await tx.update(savedCards).set({ removedAt: ctx.now }).where(inArray(savedCards.id, cards.map((k) => k.id)));
    await anonymize(tx, plan.profileIds, ctx.now);
  });
  for (const clubId of clubIds) await logAudit(db, { action: "gdpr.deleted", clubId, detail: { profiles: plan.profileIds.length } });
}

/**
 * En værge sletter et barns data. Har barnet en anden værge, fjerner man kun sig selv som værge, så den anden
 * forælder ikke mister barnets profil; ellers anonymiseres barnet.
 */
export async function deleteChildProfile(db: Db, ctx: AccessContext, childProfileId: string): Promise<"deleted" | "left"> {
  if (!ctx.wards.has(childProfileId)) throw new ForbiddenError("profile.edit");
  const [{ others }] = await db
    .select({ others: sql<number>`count(*)::int` })
    .from(guardianships)
    .where(and(eq(guardianships.childProfileId, childProfileId), sql`${guardianships.guardianProfileId} <> ${ctx.profileId}`));
  if (others > 0) {
    await db.delete(guardianships).where(and(eq(guardianships.childProfileId, childProfileId), eq(guardianships.guardianProfileId, ctx.profileId)));
    return "left";
  }
  const [{ open }] = await db.select({ open: sql<number>`count(*)::int` }).from(charges).where(and(eq(charges.profileId, childProfileId), eq(charges.status, "open")));
  if (open > 0) throw new Error(`Der er ${open} ubetalte opkrævninger. Betal dem, eller bed foreningen annullere dem, før du sletter.`);
  const clubIds = await clubsOf(db, [childProfileId]);
  await db.transaction(async (tx) => anonymize(tx, [childProfileId], ctx.now));
  for (const clubId of clubIds) await logAudit(db, { action: "gdpr.deleted", clubId, detail: { profiles: 1, child: true } });
  return "deleted";
}
