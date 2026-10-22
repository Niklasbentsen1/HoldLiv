// Spærring ved restance: har foreningen sat en grænse, kan et medlem med en forfalden, ubetalt opkrævning ikke tilmelde sig nye hold.
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { charges, clubs } from "../db/schema";
import { addDays } from "../lib/money";

type Reader = Pick<Db, "select" | "selectDistinct">;

/** Hvem af profilerne har en opkrævning, der er forfalden for mere end foreningens grænse? Tom, hvis foreningen ikke har sat en grænse. */
export async function blockedProfileIds(db: Reader, clubId: string, profileIds: string[], today: string): Promise<Set<string>> {
  if (profileIds.length === 0) return new Set();
  const [c] = await db.select({ days: clubs.arrearsBlockDays }).from(clubs).where(eq(clubs.id, clubId));
  if (!c || c.days === null) return new Set();
  const rows = await db
    .selectDistinct({ profileId: charges.profileId })
    .from(charges)
    .where(and(eq(charges.clubId, clubId), eq(charges.status, "open"), inArray(charges.profileId, profileIds), lte(charges.dueDate, addDays(today, -c.days)), sql`${charges.amountOre} > 0`));
  return new Set(rows.map((r) => r.profileId));
}
