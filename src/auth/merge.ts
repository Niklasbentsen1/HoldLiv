// Fletter en uovertaget profil ind i en eksisterende (fx forælderen, som en anden forening har importeret eller indmeldt).
// Kun de rækker, der kan flyttes uden konflikt, flyttes. Hænger profilen fast i andet (beskeder, bøder, samtykker osv.),
// eller opstår der en konflikt, der ikke kan løses, rulles hele fletningen tilbage, og profilen bliver stående som den er.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { clubMemberships, clubs, guardianships, profileMergeDismissals, profiles, users } from "../db/schema";
import { isMinor } from "./permissions";

class Abort extends Error {}

/** Tabeller og kolonner, der ikke flyttes. Findes der rækker i dem, afbrydes fletningen. */
const BLOCKING: [string, string][] = [
  ["club_roles", "profile_id"],
  ["event_responses", "profile_id"],
  ["guardianships", "child_profile_id"],
  ["carpool_offers", "driver_profile_id"],
  ["carpool_passengers", "profile_id"],
  ["carpool_requests", "profile_id"],
  ["team_tasks", "assignee_profile_id"],
  ["fines", "profile_id"],
  ["chat_messages", "author_profile_id"],
  ["posts", "author_profile_id"],
  ["consents", "profile_id"],
  ["saved_cards", "payer_profile_id"],
  ["expense_claims", "profile_id"],
];

export async function mergeProfile(db: Db, keepId: string, dupId: string): Promise<boolean> {
  if (keepId === dupId) return false;
  try {
    await db.transaction(async (tx) => {
      const k = keepId;
      const d = dupId;
      await tx.execute(sql`update club_memberships set profile_id = ${k} where profile_id = ${d} and not exists (select 1 from club_memberships x where x.club_id = club_memberships.club_id and x.profile_id = ${k})`);
      await tx.execute(sql`delete from club_memberships where profile_id = ${d}`);
      await tx.execute(sql`update guardianships set guardian_profile_id = ${k} where guardian_profile_id = ${d} and child_profile_id <> ${k} and not exists (select 1 from guardianships x where x.child_profile_id = guardianships.child_profile_id and x.guardian_profile_id = ${k})`);
      await tx.execute(sql`delete from guardianships where guardian_profile_id = ${d}`);
      await tx.execute(sql`update team_members set profile_id = ${k} where profile_id = ${d} and not exists (select 1 from team_members x where x.team_id = team_members.team_id and x.role = team_members.role and x.profile_id = ${k})`);
      await tx.execute(sql`delete from team_members where profile_id = ${d}`);
      await tx.execute(sql`update team_waitlist set profile_id = ${k} where profile_id = ${d} and not exists (select 1 from team_waitlist x where x.team_id = team_waitlist.team_id and x.profile_id = ${k}) and not exists (select 1 from team_members m where m.team_id = team_waitlist.team_id and m.profile_id = ${k} and m.role = 'player')`);
      await tx.execute(sql`delete from team_waitlist where profile_id = ${d}`);
      await tx.execute(sql`update member_field_values set profile_id = ${k} where profile_id = ${d} and not exists (select 1 from member_field_values x where x.field_id = member_field_values.field_id and x.profile_id = ${k})`);
      await tx.execute(sql`delete from member_field_values where profile_id = ${d}`);
      await tx.execute(sql`update signup_requests set profile_id = ${k} where profile_id = ${d}`);
      // Opkrævninger flyttes med; en opkrævning, der ville give en dublet for samme sats og periode (eller et ekstra indmeldelsesgebyr), afbryder.
      await tx.execute(sql`update charges set profile_id = ${k} where profile_id = ${d} and not exists (select 1 from charges x where x.profile_id = ${k} and ((x.fee_id is not distinct from charges.fee_id and charges.fee_id is not null and x.period_start = charges.period_start) or (charges.kind = 'join_fee' and x.kind = 'join_fee' and x.club_id = charges.club_id)))`);
      for (const [table, col] of [["charges", "profile_id"], ...BLOCKING] as [string, string][]) {
        const rows = await tx.execute(sql`select 1 from ${sql.identifier(table)} where ${sql.identifier(col)} = ${d} limit 1`);
        if (rows.length > 0) throw new Abort();
      }
      await tx.execute(sql`delete from profiles where id = ${d}`);
    });
    return true;
  } catch (e) {
    if (e instanceof Abort) return false;
    throw e;
  }
}

/** Uovertagne profiler med e-mailen, der hverken er børn eller mindreårige. Værger uden fødselsdato tæller med. */
export async function unclaimedProfilesByEmail(db: Db, email: string) {
  const rows = await db
    .select({
      id: profiles.id,
      firstName: profiles.firstName,
      lastName: profiles.lastName,
      birthDate: profiles.birthDate,
      isGuardian: sql<boolean>`exists (select 1 from ${guardianships} where ${guardianships.guardianProfileId} = ${profiles.id})`,
      isChild: sql<boolean>`exists (select 1 from ${guardianships} where ${guardianships.childProfileId} = ${profiles.id})`,
    })
    .from(profiles)
    .where(and(sql`lower(${profiles.email}) = ${email.toLowerCase()}`, isNull(profiles.userId), isNull(profiles.deletedAt)))
    .orderBy(profiles.createdAt);
  return rows.filter((c) => !c.isChild && (c.birthDate ? !isMinor(c.birthDate) : c.isGuardian));
}

export const firstNameOf = (n: string) => n.trim().split(/\s+/)[0].toLowerCase();

/**
 * Brugeren har allerede en profil, og en forening har registreret en anden med samme e-mail og fornavn. Det flettes ikke automatisk:
 * en forening kunne ellers oprette en profil med en andens e-mail og få vedkommendes oplysninger flettet ind. Brugeren skal selv sige ja.
 */
export async function findMergeOffers(db: Db, userId: string) {
  const [me] = await db.select({ id: profiles.id, firstName: profiles.firstName, email: users.email }).from(users).innerJoin(profiles, eq(profiles.userId, users.id)).where(eq(users.id, userId));
  if (!me) return [];
  const dismissed = new Set((await db.select({ id: profileMergeDismissals.profileId }).from(profileMergeDismissals).where(eq(profileMergeDismissals.userId, userId))).map((d) => d.id));
  const candidates = (await unclaimedProfilesByEmail(db, me.email)).filter((c) => c.id !== me.id && firstNameOf(c.firstName) === firstNameOf(me.firstName) && !dismissed.has(c.id));
  if (candidates.length === 0) return [];
  const ids = candidates.map((c) => c.id);
  const [clubRows, kidRows] = await Promise.all([
    db.select({ profileId: clubMemberships.profileId, club: clubs.name }).from(clubMemberships).innerJoin(clubs, eq(clubs.id, clubMemberships.clubId)).where(inArray(clubMemberships.profileId, ids)),
    db.select({ guardian: guardianships.guardianProfileId, n: sql<number>`count(*)::int` }).from(guardianships).where(inArray(guardianships.guardianProfileId, ids)).groupBy(guardianships.guardianProfileId),
  ]);
  return candidates.map((c) => ({
    profileId: c.id,
    name: `${c.firstName} ${c.lastName}`.trim(),
    clubs: [...new Set(clubRows.filter((r) => r.profileId === c.id).map((r) => r.club))],
    children: kidRows.find((k) => k.guardian === c.id)?.n ?? 0,
  }));
}

/** Ja: flet profilen ind i brugerens egen. Kan ikke flettes uden konflikt, får brugeren en forklaring. */
export async function acceptMergeOffer(db: Db, userId: string, profileId: string) {
  const offer = (await findMergeOffers(db, userId)).find((o) => o.profileId === profileId);
  if (!offer) throw new Error("Tilbuddet findes ikke længere.");
  const [me] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId));
  if (!(await mergeProfile(db, me.id, profileId))) throw new Error("Profilerne kunne ikke samles automatisk. Kontakt foreningen.");
}

/** Nej: profilen tilbydes ikke igen. */
export async function declineMergeOffer(db: Db, userId: string, profileId: string) {
  const offer = (await findMergeOffers(db, userId)).find((o) => o.profileId === profileId);
  if (!offer) return;
  await db.insert(profileMergeDismissals).values({ userId, profileId }).onConflictDoNothing();
}
