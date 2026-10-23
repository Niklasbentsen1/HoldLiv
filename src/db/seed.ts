import { createDb } from "./client";
import { seedBookingDemo, seedDemo, seedMatchDemo, seedTeamFundDemo, seedVolunteerDemo } from "./demo";

const { db, sql } = createDb();
const demo = await seedDemo(db);
await seedMatchDemo(db, demo);
await seedBookingDemo(db, demo);
await seedVolunteerDemo(db, demo);
await seedTeamFundDemo(db, demo);
console.log("Demoklubben Skovby IF er oprettet. Log ind med fx niklas@, mette@, sofie@ (kasserer) eller karen@holdliv.test.");
await sql.end();
