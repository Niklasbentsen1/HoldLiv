// Kør databasekald som en bestemt bruger, med row-level security slået til (migration 0015).
// Inde i fn ser databasen kun rækker fra de foreninger, brugeren (eller brugerens børn) er medlem af.
// Udenfor (migrationer, cron, webhooks, login) kører man som systemet og omgår RLS.
import { sql } from "drizzle-orm";
import type { Db } from "./client";

export const APP_ROLE = "holdliv_app";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function withUserScope<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // SET LOCAL gælder kun denne transaktion, så en pulje-forbindelse aldrig slæber et scope med sig.
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
