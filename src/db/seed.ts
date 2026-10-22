import { createDb } from "./client";
import { seedDemo } from "./demo";

const { db, sql } = createDb();
await seedDemo(db);
console.log("Demodata oprettet. Log ind som niklas@holdliv.test, mette@holdliv.test, jonas@holdliv.test eller karen@holdliv.test.");
await sql.end();
