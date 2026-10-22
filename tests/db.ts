// Fælles testdatabase. Hver testfil nulstiller den og kører migrationerne forfra.
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "../src/db/client";

export function testDb() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://holdliv:holdliv@localhost:5432/holdliv_test";
  const { db, sql } = createDb(url);
  const reset = async () => {
    await sql.unsafe("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
    await migrate(db, { migrationsFolder: "./drizzle" });
  };
  return { db, sql, reset };
}
