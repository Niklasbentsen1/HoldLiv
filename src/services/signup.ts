// Online indmeldelse: et åbent link pr. forening, hvor nye medlemmer sender en ansøgning. Admin godkender hver enkelt.
// Først ved godkendelse oprettes personen (og forælderen) og kommer på hold eller venteliste.
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubMemberships, clubRoles, clubs, guardianships, profiles, signupRequests, teamMembers, teams, users } from "../db/schema";
import { assertCan, isMinor, type AccessContext } from "../auth/permissions";
import { ageOn } from "../lib/age";
import { localDate } from "../lib/money";
import type { Mailer } from "../lib/mail";
import { logAudit } from "./audit";
import { applyTeamDefaultFee } from "./teams";
import { addToWaitlist, lockTeamSpots } from "./waitlist";
import { parseDate } from "./import";

export const MAX_TERMS_LENGTH = 5000;
/** Samme e-mail må højst sende så mange ansøgninger i døgnet, og en forening højst så mange ubehandlede. */
export const MAX_SIGNUPS_PER_EMAIL_PER_DAY = 3;
export const MAX_PENDING_PER_CLUB = 500;
/** Åben side uden login: grænser pr. afsender-IP og pr. forening i timen mod spam. */
export const MAX_SIGNUPS_PER_IP_PER_HOUR = 5;
export const MAX_SIGNUPS_PER_CLUB_PER_HOUR = 30;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SignupInfo {
  clubId: string;
  clubName: string;
  minAge: number | null;
  maxAge: number | null;
  terms: string | null;
  teams: { id: string; name: string; season: string | null }[];
}

/** Det den åbne tilmeldingsside må vise. Null, hvis foreningen ikke findes eller ikke har åbnet for indmeldelse. */
export async function getSignupInfo(db: Db, slug: string): Promise<SignupInfo | null> {
  const [c] = await db.select().from(clubs).where(eq(clubs.slug, slug));
  if (!c || !c.signupEnabled) return null;
  const list = await db.select({ id: teams.id, name: teams.name, season: teams.season }).from(teams).where(eq(teams.clubId, c.id)).orderBy(asc(teams.name));
  return { clubId: c.id, clubName: c.name, minAge: c.signupMinAge, maxAge: c.signupMaxAge, terms: c.signupTerms, teams: list };
}

export interface SignupInput {
  firstName: string;
  lastName: string;
  birthDate: string;
  email: string;
  phone?: string | null;
  guardianName?: string | null;
  teamId?: string | null;
  message?: string | null;
  acceptTerms: boolean;
}

export async function saveSignupSettings(
  db: Db,
  ctx: AccessContext,
  clubId: string,
  s: { enabled: boolean; minAge: number | null; maxAge: number | null; terms: string | null },
) {
  assertCan(ctx, { action: "club.manage", clubId });
  for (const a of [s.minAge, s.maxAge]) if (a !== null && (!Number.isInteger(a) || a < 0 || a > 120)) throw new Error("Alder skal være et helt tal fra 0 til 120.");
  if (s.minAge !== null && s.maxAge !== null && s.minAge > s.maxAge) throw new Error("Mindstealderen kan ikke være højere end højeste alder.");
  const terms = s.terms?.trim() || null;
  if (terms && terms.length > MAX_TERMS_LENGTH) throw new Error(`Betingelserne må højst være ${MAX_TERMS_LENGTH} tegn.`);
  await db.update(clubs).set({ signupEnabled: s.enabled, signupMinAge: s.minAge, signupMaxAge: s.maxAge, signupTerms: terms }).where(eq(clubs.id, clubId));
  await logAudit(db, { action: "signup.settings", clubId, actorUserId: ctx.userId, detail: { enabled: s.enabled, minAge: s.minAge, maxAge: s.maxAge } });
}

async function adminEmails(db: Db, clubId: string) {
  const rows = await db
    .select({ email: sql<string>`coalesce(${profiles.email}, ${users.email})` })
    .from(clubRoles)
    .innerJoin(profiles, eq(profiles.id, clubRoles.profileId))
    .leftJoin(users, eq(users.id, profiles.userId))
    .where(and(eq(clubRoles.clubId, clubId), eq(clubRoles.role, "admin")));
  return [...new Set(rows.map((r) => r.email).filter(Boolean))];
}

/** Modtager en ansøgning fra den åbne side. Kræver ingen login. Mails til ansøger og admin er best effort. */
export async function submitSignup(db: Db, slug: string, input: SignupInput, mail: Mailer, baseUrl: string, now = new Date(), ip: string | null = null) {
  const info = await getSignupInfo(db, slug);
  if (!info) throw new Error("Foreningen har ikke åbnet for indmeldelse her.");
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  if (!firstName || !lastName) throw new Error("Skriv for- og efternavn.");
  if (firstName.length > 100 || lastName.length > 100) throw new Error("Navnet er for langt.");
  const birthDate = parseDate(input.birthDate);
  if (!birthDate) throw new Error("Fødselsdatoen kan ikke læses. Skriv den som dd-mm-åååå.");
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new Error("Skriv en gyldig e-mail.");
  const age = ageOn(birthDate, localDate(now));
  if (info.minAge !== null && age < info.minAge) throw new Error(`Man skal være mindst ${info.minAge} år for at melde sig ind her.`);
  if (info.maxAge !== null && age > info.maxAge) throw new Error(`Indmeldelsen er for personer til og med ${info.maxAge} år.`);
  const minor = isMinor(birthDate, now);
  const guardianName = input.guardianName?.trim() || null;
  if (minor && !guardianName) throw new Error("Er du under 18 år, skal en forælder eller værge skrive sig på. Skriv forælderens navn og e-mail.");
  const guardianParts = guardianName?.split(/\s+/).filter(Boolean) ?? [];
  if (minor && guardianParts.length < 2) throw new Error("Skriv forælderens for- og efternavn.");
  if (!input.acceptTerms) throw new Error("Du skal acceptere foreningens betingelser og privatlivspolitikken.");
  let teamId: string | null = null;
  if (input.teamId) {
    if (!info.teams.some((t) => t.id === input.teamId)) throw new Error("Holdet findes ikke.");
    teamId = input.teamId;
  }
  const message = input.message?.trim().slice(0, 1000) || null;
  const phone = input.phone?.trim().slice(0, 40) || null;

  const [{ recent }] = await db
    .select({ recent: count() })
    .from(signupRequests)
    .where(and(eq(signupRequests.contactEmail, email), gt(signupRequests.createdAt, new Date(now.getTime() - 86_400_000))));
  if (recent >= MAX_SIGNUPS_PER_EMAIL_PER_DAY) throw new Error("Der er sendt flere ansøgninger fra den e-mail i dag. Prøv igen i morgen.");
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const ipHash = ip ? createHash("sha256").update(ip).digest("hex") : null;
  if (ipHash) {
    const [{ fromIp }] = await db.select({ fromIp: count() }).from(signupRequests).where(and(eq(signupRequests.ipHash, ipHash), gt(signupRequests.createdAt, hourAgo)));
    if (fromIp >= MAX_SIGNUPS_PER_IP_PER_HOUR) throw new Error("Der er sendt mange ansøgninger herfra. Prøv igen om lidt.");
  }
  const [{ lastHour }] = await db.select({ lastHour: count() }).from(signupRequests).where(and(eq(signupRequests.clubId, info.clubId), gt(signupRequests.createdAt, hourAgo)));
  if (lastHour >= MAX_SIGNUPS_PER_CLUB_PER_HOUR) throw new Error("Foreningen har fået mange ansøgninger det sidste stykke tid. Prøv igen om lidt.");
  const [{ pending }] = await db.select({ pending: count() }).from(signupRequests).where(and(eq(signupRequests.clubId, info.clubId), eq(signupRequests.status, "pending")));
  if (pending >= MAX_PENDING_PER_CLUB) throw new Error("Foreningen har mange ubehandlede ansøgninger lige nu. Prøv igen senere.");
  const [dup] = await db
    .select({ id: signupRequests.id })
    .from(signupRequests)
    .where(and(eq(signupRequests.clubId, info.clubId), eq(signupRequests.status, "pending"), sql`lower(${signupRequests.firstName}) = ${firstName.toLowerCase()}`, sql`lower(${signupRequests.lastName}) = ${lastName.toLowerCase()}`, eq(signupRequests.birthDate, birthDate)));
  if (dup) throw new Error("Vi har allerede modtaget en ansøgning for den person. Foreningen vender tilbage.");

  const [row] = await db
    .insert(signupRequests)
    .values({
      clubId: info.clubId,
      teamId,
      firstName,
      lastName,
      birthDate,
      contactEmail: email,
      phone,
      guardianFirstName: minor ? guardianParts.slice(0, -1).join(" ") : null,
      guardianLastName: minor ? guardianParts[guardianParts.length - 1] : null,
      message,
      termsText: info.terms,
      termsAcceptedAt: now,
      createdAt: now,
      ipHash,
    })
    .returning({ id: signupRequests.id });
  try {
    // Ansøgerens fritekstnavn gentages ikke i mails. Admin får højst én mail i timen, så siden ikke kan oversvømme indbakken.
    await mail(email, `Vi har modtaget din ansøgning til ${info.clubName}`, `Hej\n\nTak for ansøgningen om medlemskab af ${info.clubName}. Foreningen læser den og skriver til dig, når den er behandlet.\n\nHar du ikke bedt om det, kan du se bort fra mailen.`);
    if (lastHour === 0) {
      for (const to of await adminEmails(db, info.clubId)) {
        await mail(to, `Nye ansøgninger til ${info.clubName}`, `Der er kommet en ny ansøgning om medlemskab.\n\nSe og godkend ansøgninger her: ${baseUrl}/forening/tilmeldinger?klub=${info.clubId}`);
      }
    }
  } catch (e) {
    console.error("Mail om ansøgning fejlede", e);
  }
  return { id: row.id };
}

export async function listSignups(db: Db, ctx: AccessContext, clubId: string, status: "pending" | "approved" | "rejected" = "pending") {
  assertCan(ctx, { action: "club.manage", clubId });
  const rows = await db
    .select({ r: signupRequests, teamName: teams.name })
    .from(signupRequests)
    .leftJoin(teams, eq(teams.id, signupRequests.teamId))
    .where(and(eq(signupRequests.clubId, clubId), eq(signupRequests.status, status)))
    .orderBy(status === "pending" ? asc(signupRequests.createdAt) : desc(signupRequests.decidedAt))
    .limit(200);
  return rows.map(({ r, teamName }) => ({
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    birthDate: r.birthDate,
    age: ageOn(r.birthDate, localDate(ctx.now)),
    minor: isMinor(r.birthDate, ctx.now),
    contactEmail: r.contactEmail,
    phone: r.phone,
    guardianName: r.guardianFirstName ? `${r.guardianFirstName} ${r.guardianLastName}` : null,
    teamId: r.teamId,
    teamName,
    message: r.message,
    createdAt: r.createdAt,
    decisionNote: r.decisionNote,
  }));
}

/** Godkender (opretter medlem, evt. forælder, hold eller venteliste) eller afviser en ansøgning, og skriver til ansøgeren. */
export async function decideSignup(
  db: Db,
  ctx: AccessContext,
  requestId: string,
  decision: { approve: true; teamId?: string | null } | { approve: false; note?: string | null },
  mail: Mailer,
) {
  const [req] = await db.select().from(signupRequests).where(eq(signupRequests.id, requestId));
  if (!req) throw new Error("Ansøgningen findes ikke.");
  assertCan(ctx, { action: "club.manage", clubId: req.clubId });
  const [club] = await db.select({ name: clubs.name }).from(clubs).where(eq(clubs.id, req.clubId));

  if (!decision.approve) {
    const note = decision.note?.trim().slice(0, 500) || null;
    const done = await db
      .update(signupRequests)
      .set({ status: "rejected", decidedAt: ctx.now, decidedByUserId: ctx.userId, decisionNote: note })
      .where(and(eq(signupRequests.id, requestId), eq(signupRequests.status, "pending")))
      .returning({ id: signupRequests.id });
    if (done.length === 0) throw new Error("Ansøgningen er allerede behandlet.");
    await logAudit(db, { action: "signup.rejected", clubId: req.clubId, actorUserId: ctx.userId, targetType: "signup", targetId: requestId });
    await tell(mail, req.contactEmail, `Din ansøgning til ${club.name}`, `Hej\n\nForeningen kan desværre ikke optage ${req.firstName} ${req.lastName} lige nu.${note ? `\n\nBesked fra foreningen: ${note}` : ""}`);
    return { status: "rejected" as const };
  }

  const teamId = decision.teamId === undefined ? req.teamId : decision.teamId;
  if (teamId) {
    const [t] = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, teamId), eq(teams.clubId, req.clubId)));
    if (!t) throw new Error("Holdet hører ikke til foreningen.");
  }
  const minor = isMinor(req.birthDate, ctx.now);
  const result = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(signupRequests)
      .set({ status: "approved", decidedAt: ctx.now, decidedByUserId: ctx.userId })
      .where(and(eq(signupRequests.id, requestId), eq(signupRequests.status, "pending")))
      .returning({ id: signupRequests.id });
    if (claimed.length === 0) throw new Error("Ansøgningen er allerede behandlet.");

    let profileId: string;
    if (!minor) {
      // Har personen allerede en profil med samme navn og e-mail (fx fra et andet hold), bruges den.
      // Kun en profil, der allerede er medlem af denne forening, genbruges. Ellers oprettes en ny, og først når ejeren af e-mailen selv
      // logger ind, flettes den med den eksisterende profil (claimProfile). Så ser en forening aldrig en anden forenings oplysninger.
      const [same] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .innerJoin(clubMemberships, and(eq(clubMemberships.profileId, profiles.id), eq(clubMemberships.clubId, req.clubId)))
        .where(and(sql`lower(${profiles.email}) = ${req.contactEmail}`, sql`lower(${profiles.firstName}) = ${req.firstName.toLowerCase()}`, sql`lower(${profiles.lastName}) = ${req.lastName.toLowerCase()}`, sql`${profiles.deletedAt} is null`));
      profileId = same
        ? same.id
        : (await tx.insert(profiles).values({ firstName: req.firstName, lastName: req.lastName, birthDate: req.birthDate, email: req.contactEmail, phone: req.phone, createdByUserId: ctx.userId }).returning({ id: profiles.id }))[0].id;
    } else {
      profileId = (await tx.insert(profiles).values({ firstName: req.firstName, lastName: req.lastName, birthDate: req.birthDate, phone: null, createdByUserId: ctx.userId }).returning({ id: profiles.id }))[0].id;
      // Forælderen genbruges kun, hvis vedkommende allerede er forælder til et medlem i denne forening; ellers oprettes en, som overtages eller flettes ved login.
      const [g] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .innerJoin(guardianships, eq(guardianships.guardianProfileId, profiles.id))
        .innerJoin(clubMemberships, and(eq(clubMemberships.profileId, guardianships.childProfileId), eq(clubMemberships.clubId, req.clubId)))
        .where(and(sql`lower(${profiles.email}) = ${req.contactEmail}`, sql`lower(${profiles.firstName}) = ${(req.guardianFirstName ?? "").toLowerCase()}`, sql`lower(${profiles.lastName}) = ${(req.guardianLastName ?? "").toLowerCase()}`, sql`${profiles.deletedAt} is null`))
        .limit(1);
      const guardianId = g
        ? g.id
        : (await tx.insert(profiles).values({ firstName: req.guardianFirstName ?? "Forælder", lastName: req.guardianLastName ?? "", email: req.contactEmail, phone: req.phone, createdByUserId: ctx.userId }).returning({ id: profiles.id }))[0].id;
      await tx.insert(guardianships).values({ guardianProfileId: guardianId, childProfileId: profileId }).onConflictDoNothing();
    }
    await tx.insert(clubMemberships).values({ clubId: req.clubId, profileId }).onConflictDoNothing();
    let placement: "none" | "team" | "waitlist" = "none";
    if (teamId) {
      const spots = await lockTeamSpots(tx, teamId);
      // Samme regel som invitationslinket: er holdet fuldt, eller venter nogen, kommer nykommeren bag i køen.
      if (spots.full || spots.waiting > 0) {
        await addToWaitlist(tx, ctx.userId, teamId, profileId, null);
        placement = "waitlist";
      } else {
        await tx.insert(teamMembers).values({ teamId, profileId, role: "player" }).onConflictDoNothing();
        await applyTeamDefaultFee(tx, teamId, profileId);
        placement = "team";
      }
    }
    await tx.update(signupRequests).set({ profileId }).where(eq(signupRequests.id, requestId));
    return { profileId, placement };
  });
  await logAudit(db, { action: "signup.approved", clubId: req.clubId, actorUserId: ctx.userId, targetType: "signup", targetId: requestId, detail: { placement: result.placement } });
  const where = result.placement === "waitlist" ? " Holdet er fuldt, så der er skrevet på ventelisten." : result.placement === "team" ? " Der er plads på holdet." : "";
  await tell(mail, req.contactEmail, `Velkommen til ${club.name}`, `Hej\n\n${req.firstName} ${req.lastName} er nu medlem af ${club.name}.${where}\n\nLog ind i HoldLiv med denne e-mail (${req.contactEmail}) for at se kalender og tilmelde dig aktiviteter.`);
  return { status: "approved" as const, ...result };
}

async function tell(mail: Mailer, to: string, subject: string, text: string) {
  try {
    await mail(to, subject, text);
  } catch (e) {
    console.error("Mail om ansøgning fejlede", e);
  }
}
