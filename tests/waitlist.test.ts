// Antal pladser og venteliste på en aktivitet, mod en rigtig Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { getEventDetail, respondToEvent, respondToEventNotifying, splitYes, updateEventNotifying, type Deliver } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
const mails: { to: string; subject: string }[] = [];
const deliver: Deliver = {
  baseUrl: "https://holdliv.test",
  mail: async (to, subject) => {
    mails.push({ to, subject });
  },
  sms: null,
};

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
});
afterAll(async () => {
  await sql.end();
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const event = () => demo.events.u9Training;
const K = () => demo.kids;
const BASE = Date.parse("2026-01-01T10:00:00Z");

/** Træneren registrerer et svar; tidspunktet for "kommer" sættes fast, så rækkefølgen er entydig. */
async function answer(profileId: string, status: "yes" | "no" | "maybe", second = 0) {
  await respondToEvent(db, await ctxOf("mette"), event().id, profileId, status);
  if (status === "yes") await sql`update event_responses set yes_since = ${new Date(BASE + second * 1000).toISOString()} where event_id = ${event().id} and profile_id = ${profileId}`;
}
const detail = async () => getEventDetail(db, await ctxOf("mette"), event().id);
const names = (l: { firstName: string }[]) => l.map((p) => p.firstName);

beforeEach(async () => {
  mails.length = 0;
  await sql`delete from event_responses where event_id = ${event().id}`;
  await sql`delete from notifications`;
  await sql`update events set max_participants = null where id = ${event().id}`;
});

describe("rækkefølge", () => {
  it("de første får plads, resten står i køen", () => {
    const rows = [
      { profileId: "b", yesSince: new Date(2000) },
      { profileId: "a", yesSince: new Date(1000) },
      { profileId: "c", yesSince: new Date(3000) },
    ];
    const r = splitYes(rows, 2);
    expect(r.confirmed.map((x) => x.profileId)).toEqual(["a", "b"]);
    expect(r.waitlist.map((x) => x.profileId)).toEqual(["c"]);
    expect(splitYes(rows, null).waitlist).toEqual([]);
  });
});

describe("venteliste på en aktivitet", () => {
  beforeEach(async () => {
    await updateEventNotifying(db, await ctxOf("mette"), deliver, event().id, { maxParticipants: 2 });
    await answer(K().emma.id, "yes", 1);
    await answer(K().ida.id, "yes", 2);
    await answer(K().noor.id, "yes", 3);
    await answer(K().freja.id, "yes", 4);
    mails.length = 0;
  });

  it("viser pladser, venteliste og placering", async () => {
    const d = await detail();
    expect(names(d.groups.yes)).toEqual(["Emma", "Ida"]);
    expect(names(d.groups.waitlist)).toEqual(["Noor", "Freja"]);
    expect(d.groups.waitlist.map((p) => p.waitlistPosition)).toEqual([1, 2]);
    expect(d.spotsLeft).toBe(0);
  });

  it("beholder pladsen i køen, når man blot ændrer sin besked", async () => {
    const before = (await sql`select yes_since from event_responses where event_id = ${event().id} and profile_id = ${K().noor.id}`)[0].yes_since;
    await respondToEvent(db, await ctxOf("mette"), event().id, K().noor.id, "yes", "Glæder os");
    const after = (await sql`select yes_since from event_responses where event_id = ${event().id} and profile_id = ${K().noor.id}`)[0].yes_since;
    expect(after).toEqual(before);
  });

  it("rykker den første op og giver besked, når en plads bliver ledig", async () => {
    await respondToEventNotifying(db, await ctxOf("mette"), deliver, event().id, K().emma.id, "no");
    const d = await detail();
    expect(names(d.groups.yes)).toEqual(["Ida", "Noor"]);
    expect(names(d.groups.waitlist)).toEqual(["Freja"]);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("ali@holdliv.test");
    expect(mails[0].subject).toMatch(/^Der er en plads: Træning, U9 piger$/);
  });

  it("giver ingen besked, når en på ventelisten melder fra, og den der rykker op, får kun én besked", async () => {
    await respondToEventNotifying(db, await ctxOf("mette"), deliver, event().id, K().noor.id, "no");
    expect(mails).toEqual([]);
    await respondToEventNotifying(db, await ctxOf("mette"), deliver, event().id, K().emma.id, "maybe");
    expect(mails.map((m) => m.to).sort()).toEqual(["anne@holdliv.test", "lars@holdliv.test"]); // Frejas to forældre
    await respondToEventNotifying(db, await ctxOf("mette"), deliver, event().id, K().emma.id, "maybe");
    expect(mails).toHaveLength(2);
  });

  it("flere pladser rykker flere op", async () => {
    await updateEventNotifying(db, await ctxOf("mette"), deliver, event().id, { maxParticipants: 4 });
    expect(names((await detail()).groups.waitlist)).toEqual([]);
    expect(mails.map((m) => m.to).sort()).toEqual(["ali@holdliv.test", "anne@holdliv.test", "lars@holdliv.test"]);
  });

  it("den, der svarer ja igen efter at have meldt fra, står bagerst", async () => {
    await answer(K().emma.id, "no");
    await answer(K().emma.id, "yes", 99);
    const d = await detail();
    expect(names(d.groups.yes)).toEqual(["Ida", "Noor"]);
    expect(names(d.groups.waitlist)).toEqual(["Freja", "Emma"]);
  });

  it("en fjernet spiller og trænerens eget svar optager ingen plads", async () => {
    await sql`delete from team_members where team_id = ${demo.teams.u9.id} and profile_id = ${K().emma.id}`;
    // Emma er fjernet fra holdet, men har stadig et gammelt "kommer". Ida og Noor har pladserne, Freja står først i køen.
    await sql`insert into event_responses (event_id, profile_id, status, responded_by_user_id, yes_since)
      values (${event().id}, ${demo.users.mette.profile.id}, 'yes', ${demo.users.mette.user.id}, ${new Date(BASE).toISOString()})`;
    mails.length = 0;
    const d = await detail();
    expect(names(d.groups.yes)).toEqual(["Ida", "Noor"]);
    expect(names(d.groups.waitlist)).toEqual(["Freja"]);
    // Når Ida melder fra, rykker Freja op (og hendes forældre får besked), ikke nogen skjult.
    await respondToEventNotifying(db, await ctxOf("mette"), deliver, event().id, K().ida.id, "no");
    expect(mails.map((m) => m.to).sort()).toEqual(["anne@holdliv.test", "lars@holdliv.test"]);
    // Trænerens eget svar fjernes igen uden at give nogen besked.
    mails.length = 0;
    await sql`delete from event_responses where event_id = ${event().id} and profile_id = ${demo.users.mette.profile.id}`;
    await respondToEventNotifying(db, await ctxOf("mette"), deliver, event().id, K().noor.id, "no");
    expect(mails).toEqual([]);
    await sql`insert into team_members (team_id, profile_id, role) values (${demo.teams.u9.id}, ${K().emma.id}, 'player')`;
  });

  it("uden grænse er alle med, og ugyldige antal afvises", async () => {
    await updateEventNotifying(db, await ctxOf("mette"), deliver, event().id, { maxParticipants: null });
    expect((await detail()).groups.waitlist).toEqual([]);
    for (const bad of [0, -1, 2.5, 501]) {
      await expect(updateEventNotifying(db, await ctxOf("mette"), deliver, event().id, { maxParticipants: bad })).rejects.toThrow(/Antal pladser/);
    }
  });
});
