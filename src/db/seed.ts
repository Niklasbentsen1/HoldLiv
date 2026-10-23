import { createDb } from "./client";
import { seedDemo, seedMatchDemo } from "./demo";

const { db, sql } = createDb();
const demo = await seedDemo(db);
await seedMatchDemo(db, demo);
console.log("Demoklubben Skovby IF er oprettet. Log ind med fx niklas@, mette@, sofie@ (kasserer) eller karen@holdliv.test.");
await sql.end();
