// Samkørsel mod en rigtig Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { setEventCancelled, setTeamModule, bookSeat, cancelOffer, cancelRideRequest, getEventCarpool, leaveSeat, listCarpoolEvents, offerRide, requestRide, updateOffer } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
let match: string;

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
  const admin = await loadAccessContext(db, demo.users.karen.user.id);
  await setTeamModule(db, admin, demo.teams.u9.id, "carpool", true);
  match = demo.events.u9Match.id;
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const kid = (k: keyof typeof demo.kids) => demo.kids[k].id;
const offerOf = async (who: keyof typeof demo.users) => {
  const c = await getEventCarpool(db, await ctxOf("mette"), match);
  return c.offers.find((o) => o.driverName.startsWith(demo.users[who].profile.firstName))!;
};

describe("samkørsel", () => {
  it("kræver at modulet er slået til for holdet", async () => {
    const jonas = await ctxOf("jonas");
    // U11 har ikke modulet, og Jonas er ikke på U9.
    await expect(offerRide(db, jonas, match, { seats: 3, meetingPoint: "P-pladsen" })).rejects.toBeInstanceOf(ForbiddenError);
    const admin = await ctxOf("karen");
    await expect(getEventCarpool(db, admin, demo.events.seniorTraining.id)).rejects.toThrow(/ikke slået til/);
  });

  it("en forælder tilbyder pladser, og pladserne valideres", async () => {
    const ali = await ctxOf("ali");
    await expect(offerRide(db, ali, match, { seats: 0, meetingPoint: "P" })).rejects.toThrow(/pladser/);
    await expect(offerRide(db, ali, match, { seats: 3, meetingPoint: "  " })).rejects.toThrow(/mødes/);
    await offerRide(db, ali, match, { seats: 2, meetingPoint: "Skovby skole", note: "Vi kører kl. 9" });
    await expect(offerRide(db, ali, match, { seats: 2, meetingPoint: "Skovby skole" })).rejects.toThrow(/allerede/);
  });

  it("sætter egne børn på bilen og afviser andres børn", async () => {
    const niklas = await ctxOf("niklas");
    const ali = await ctxOf("ali");
    const o = await offerOf("ali");
    await bookSeat(db, niklas, o.id, kid("emma"));
    // Anne må ikke sætte Ida (Sofies barn) på bilen.
    await expect(bookSeat(db, await ctxOf("anne"), o.id, kid("ida"))).rejects.toThrow(/må ikke/);
    // Føreren må ikke tage et barn, der ikke har bedt om en lift. Emma sidder allerede i bilen, så prøv Alma.
    await expect(bookSeat(db, ali, o.id, kid("alma"))).rejects.toThrow(/ikke bedt om en lift/);
    // Alis egen datter Noor sættes på af Ali som forælder.
    await bookSeat(db, ali, o.id, kid("noor"));
    const fresh = await offerOf("ali");
    expect(fresh.free).toBe(0);
    expect(fresh.passengers.map((p) => p.name.split(" ")[0]).sort()).toEqual(["Emma", "Noor"]);
  });

  it("overbooker ikke, heller ikke når to trykker samtidig", async () => {
    await offerRide(db, await ctxOf("henrik"), match, { seats: 1, meetingPoint: "Klubhuset" });
    const o = await offerOf("henrik");
    // Alis bil er fuld (Emma og Noor), også selv om Alma har bedt om en lift.
    await requestRide(db, await ctxOf("henrik"), match, kid("alma"));
    await expect(bookSeat(db, await ctxOf("ali"), (await offerOf("ali")).id, kid("alma"))).rejects.toThrow(/fuld/);
    await cancelRideRequest(db, await ctxOf("henrik"), match, kid("alma"));
    const results = await Promise.allSettled([
      bookSeat(db, await ctxOf("sofie"), o.id, kid("ida")),
      bookSeat(db, await ctxOf("anne"), o.id, kid("freja")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await offerOf("henrik")).passengers).toHaveLength(1);
  });

  it("flytter en spiller mellem biler", async () => {
    const sofie = await ctxOf("sofie");
    const lars = await ctxOf("lars");
    await offerRide(db, lars, match, { seats: 3, meetingPoint: "Brugsen" });
    const before = await getEventCarpool(db, sofie, match);
    const larsOffer = before.offers.find((o) => o.driverName.startsWith("Lars"))!;
    const idaCar = before.offers.find((o) => o.passengers.some((p) => p.name.startsWith("Ida")));
    expect(idaCar).toBeTruthy();
    expect(larsOffer.movable.map((m) => m.firstName)).toEqual(["Ida"]);
    await bookSeat(db, sofie, larsOffer.id, kid("ida"));
    expect((await offerOf("lars")).passengers.map((p) => p.name.split(" ")[0])).toEqual(["Ida"]);
    expect((await offerOf("henrik")).passengers).toHaveLength(0);
  });

  it("en fører kan ikke flytte et barn fra en anden bil, men tager gerne et barn med, der mangler lift", async () => {
    const henrik = await ctxOf("henrik");
    const sofie = await ctxOf("sofie");
    const ali = await ctxOf("ali");
    // Ida sidder i Henriks eller Lars' bil (sat af Sofie). Alis bil har plads efter at Noor er taget af.
    const aliOffer = await offerOf("ali");
    await leaveSeat(db, ali, aliOffer.id, kid("noor"));
    const idaCar = (await getEventCarpool(db, sofie, match)).offers.find((o) => o.passengers.some((p) => p.name.startsWith("Ida")))!;
    expect(idaCar.driverName).not.toMatch(/^Ali/);
    await expect(bookSeat(db, ali, aliOffer.id, kid("ida"))).rejects.toThrow(/ikke bedt om en lift/);
    expect((await getEventCarpool(db, sofie, match)).offers.find((o) => o.id === idaCar.id)!.passengers.map((p) => p.name)).toContainEqual(expect.stringMatching(/^Ida/));
    // Alma mangler en lift (Henrik er hendes far, men hun har ikke plads). Ali kan tage hende med.
    await requestRide(db, henrik, match, kid("alma"));
    const req = (await getEventCarpool(db, ali, match)).requests.find((r) => r.name.startsWith("Alma"))!;
    expect(req.takeIn.map((t) => t.offerId)).toEqual([aliOffer.id]);
    await bookSeat(db, ali, aliOffer.id, kid("alma"));
    expect((await getEventCarpool(db, ali, match)).requests.map((r) => r.name)).not.toContainEqual(expect.stringMatching(/^Alma/));
    await leaveSeat(db, ali, aliOffer.id, kid("alma"));
    await bookSeat(db, ali, aliOffer.id, kid("noor"));
  });

  it("liftønsker: kun for egne børn, og en plads fjerner ønsket", async () => {
    const anne = await ctxOf("anne");
    await requestRide(db, anne, match, kid("freja"), "Vi har ingen bil");
    expect((await getEventCarpool(db, anne, match)).requests.map((r) => r.name.split(" ")[0])).toEqual(["Freja"]);
    await expect(requestRide(db, anne, match, kid("alma"))).rejects.toThrow(/må ikke/);
    // Kasper er ikke på U9.
    await expect(requestRide(db, anne, match, kid("kasper"))).rejects.toThrow(/ikke på holdet/);
    const lars = await offerOf("lars");
    await bookSeat(db, await ctxOf("anne"), lars.id, kid("freja"));
    expect((await getEventCarpool(db, anne, match)).requests).toEqual([]);
    await expect(requestRide(db, anne, match, kid("freja"))).rejects.toThrow(/allerede/);
  });

  it("telefonnumre vises kun for dem der har brug for dem", async () => {
    // Lars' bil har Ida (Sofie) og Freja (Anne) som passagerer. Lars får et telefonnummer.
    await sql`update profiles set phone = '11 22 33 44' where id = ${demo.users.lars.profile.id}`;
    const larsCar = async (who: keyof typeof demo.users) =>
      (await getEventCarpool(db, await ctxOf(who), match)).offers.find((o) => o.driverName.startsWith("Lars"))!;
    for (const who of ["lars", "mette", "sofie", "anne"] as const) expect((await larsCar(who)).driverPhone).toBe("11 22 33 44");
    expect((await larsCar("ali")).driverPhone).toBeNull(); // udenforstående forælder

    // Føreren og træneren ser forældrenes numre, andre gør ikke.
    const idaPhones = async (who: keyof typeof demo.users) =>
      (await larsCar(who)).passengers.find((p) => p.name.startsWith("Ida"))!.guardianPhones;
    expect(await idaPhones("lars")).toEqual(["Sofie: 30 12 34 56"]);
    expect(await idaPhones("mette")).toEqual(["Sofie: 30 12 34 56"]);
    expect(await idaPhones("ali")).toEqual([]);
  });

  it("føreren retter bilen, men ikke under antallet af passagerer, og kun egen bil", async () => {
    const lars = await ctxOf("lars");
    const o = await offerOf("lars");
    expect(o.passengers).toHaveLength(2); // Ida og Freja
    await expect(updateOffer(db, lars, o.id, { seats: 1, meetingPoint: "Brugsen" })).rejects.toThrow(/sidder allerede 2/);
    await expect(updateOffer(db, lars, o.id, { seats: 0, meetingPoint: "Brugsen" })).rejects.toThrow(/pladser/);
    await expect(updateOffer(db, await ctxOf("sofie"), o.id, { seats: 4, meetingPoint: "X" })).rejects.toThrow(/ikke din/);
    await updateOffer(db, lars, o.id, { seats: 4, meetingPoint: "Skovby Brugs" });
    await updateOffer(db, await ctxOf("mette"), o.id, { seats: 3, meetingPoint: "Skovby Brugs" }); // træner må også
    const after = await offerOf("lars");
    expect(after).toMatchObject({ seats: 3, free: 1, meetingPoint: "Skovby Brugs" });
  });

  it("tage af bilen, slette bilen og ønsker", async () => {
    const lars = await ctxOf("lars");
    const o = await offerOf("lars");
    const rider = o.passengers[0];
    await expect(leaveSeat(db, await ctxOf("ali"), o.id, rider.profileId)).rejects.toThrow(/må ikke/);
    await leaveSeat(db, lars, o.id, rider.profileId);
    await expect(cancelOffer(db, await ctxOf("sofie"), o.id)).rejects.toThrow(/ikke din/);
    await cancelOffer(db, await ctxOf("mette"), o.id);
    expect((await getEventCarpool(db, lars, match)).offers.some((x) => x.id === o.id)).toBe(false);
    // Noor sidder i Alis bil. Hun tages af og beder om lift, og ønsket kan fortrydes igen.
    const ali = await ctxOf("ali");
    await leaveSeat(db, ali, (await offerOf("ali")).id, kid("noor"));
    await requestRide(db, ali, match, kid("noor"));
    expect((await getEventCarpool(db, ali, match)).requests.map((r) => r.name.split(" ")[0])).toContain("Noor");
    await cancelRideRequest(db, ali, match, kid("noor"));
    expect((await getEventCarpool(db, ali, match)).requests.map((r) => r.name.split(" ")[0])).not.toContain("Noor");
  });

  it("børn med eget login og under 18 kan ikke tilbyde at køre", async () => {
    await sql`update profiles set birth_date = '2012-01-01' where id = ${demo.users.jonas.profile.id}`;
    const admin = await ctxOf("karen");
    await setTeamModule(db, admin, demo.teams.u11.id, "carpool", true);
    const u11Training = (await sql`select id from events where team_id = ${demo.teams.u11.id} and starts_at > now() order by starts_at limit 1`)[0].id;
    await expect(offerRide(db, await ctxOf("jonas"), u11Training, { seats: 2, meetingPoint: "P" })).rejects.toThrow(/voksne/);
  });

  it("er lukket for aflyste og begyndte aktiviteter", async () => {
    const mette = await ctxOf("mette");
    await expect(offerRide(db, await ctxOf("niklas"), demo.events.u9PastMatch.id, { seats: 2, meetingPoint: "P" })).rejects.toThrow(/begyndt/);
    await setEventCancelled(db, mette, match, true);
    await expect(offerRide(db, await ctxOf("niklas"), match, { seats: 2, meetingPoint: "P" })).rejects.toThrow(/aflyst/);
    expect((await listCarpoolEvents(db, mette, demo.teams.u9.id)).map((e) => e.id)).not.toContain(match);
    await setEventCancelled(db, mette, match, false);
  });
});
