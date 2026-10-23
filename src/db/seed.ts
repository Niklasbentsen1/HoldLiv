import { createDb } from "./client";
import { seedBookingDemo, seedDemo, seedMatchDemo } from "./demo";

const { db, sql } = createDb();
const demo = await seedDemo(db);
await seedMatchDemo(db, demo);
await seedBookingDemo(db, demo);
console.log("Demoklubben Skovby IF er oprettet. Log ind med fx niklas@, mette@, sofie@ (kasserer) eller karen@holdliv.test.");
await sql.end();
