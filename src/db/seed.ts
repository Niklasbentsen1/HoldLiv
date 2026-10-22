import { createDb } from "./client";
import { seedDemo } from "./demo";

const { db, sql } = createDb();
await seedDemo(db);
console.log("Demoklubben Skovby IF er oprettet. Log ind med fx niklas@, mette@, sofie@ eller karen@holdliv.test.");
await sql.end();
