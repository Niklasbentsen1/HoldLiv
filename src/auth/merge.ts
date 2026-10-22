// Fletter en uovertaget profil ind i en eksisterende (fx forælderen, som en anden forening har importeret eller indmeldt).
// Kun de rækker, der kan flyttes uden konflikt, flyttes. Hænger profilen fast i andet (beskeder, bøder, samtykker osv.),
// eller opstår der en konflikt, der ikke kan løses, rulles hele fletningen tilbage, og profilen bliver stående som den er.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

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
      // Opkrævninger flyttes med; en opkrævning, der ville give en dublet for samme sats og periode, afbryder.
      await tx.execute(sql`update charges set profile_id = ${k} where profile_id = ${d} and not exists (select 1 from charges x where x.profile_id = ${k} and x.fee_id is not distinct from charges.fee_id and charges.fee_id is not null and x.period_start = charges.period_start)`);
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
