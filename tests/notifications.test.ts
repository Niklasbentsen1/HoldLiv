// Beskeder om ændringer og aflysninger mod en rigtig Postgres, med en falsk mail- og SMS-udbyder.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { notificationPrefs, notifications } from "../src/db/schema";
import { normalizePhone } from "../src/lib/sms";
import {
  getNotificationPrefs,
  listMyNotifications,
  notifyUsers,
  recipientsOfPlayers,
  sendUnansweredReminders,
  setEventCancelledNotifying,
  setNotificationPref,
  updateEventNotifying,
  type Deliver,
} from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;

const mails: { to: string; subject: string; text: string }[] = [];
const texts: { to: string; text: string }[] = [];
let failMailFor: string | null = null;
const deliver: Deliver = {
  baseUrl: "https://holdliv.test",
  mail: async (to, subject, text) => {
    if (to === failMailFor) throw new Error("Mailudbyderen er nede");
    mails.push({ to, subject, text });
  },
  sms: async (to, text) => {
    texts.push({ to, text });
  },
};

beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
});
afterAll(async () => {
  await sql.end();
});
beforeEach(async () => {
  await db.delete(notificationPrefs);
  await db.delete(notifications);
  mails.length = 0;
  texts.length = 0;
  failMailFor = null;
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const mailOf = (key: keyof typeof demo.users) => `${key}@holdliv.test`;
const FAMILIES = ["niklas", "sofie", "ali", "anne", "lars", "henrik"] as const;
const training = () => demo.events.u9Training;

describe("telefonnumre", () => {
  it("godkender danske mobilnumre og afviser resten", () => {
    expect(normalizePhone("20 11 22 33")).toBe("4520112233");
    expect(normalizePhone("+45 20112233")).toBe("4520112233");
    expect(normalizePhone("0045 20112233")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
  });
});

describe("modtagere", () => {
  it("er spilleren selv og forældre til børn under 18", async () => {
    const r = await recipientsOfPlayers(db, [demo.kids.freja.id, demo.kids.emma.id]);
    expect(r.map((x) => x.email).sort()).toEqual([mailOf("anne"), mailOf("lars"), mailOf("niklas")]);
  });

  it("forældre mister beskeder, når barnet fylder 18", async () => {
    const later = new Date("2036-01-01T12:00:00Z");
    expect(await recipientsOfPlayers(db, [demo.kids.emma.id], later)).toEqual([]);
  });
});

describe("ændringer", () => {
  it("giver alle familier på holdet besked om nyt tidspunkt, men ikke den der ændrede", async () => {
    const mette = await ctxOf("mette");
    const e = training();
    await updateEventNotifying(db, mette, deliver, e.id, { startsAt: new Date(e.startsAt.getTime() + 3_600_000) });
    expect(mails.map((m) => m.to).sort()).toEqual(FAMILIES.map(mailOf).sort());
    const m = mails[0];
    expect(m.subject).toMatch(/^Ændret: .*U9 piger/);
    expect(m.text).toMatch(/Tid: .* -> /);
    expect(m.text).toContain(`https://holdliv.test/aktivitet/${e.id}`);
    expect(m.text).toContain("https://holdliv.test/indstillinger");
    expect(texts).toEqual([]); // SMS er slået fra som standard
  });

  it("er tavs, når intet vigtigt ændres, og når en forælder ikke må rette", async () => {
    const mette = await ctxOf("mette");
    const e = training();
    await updateEventNotifying(db, mette, deliver, e.id, { description: "Husk drikkedunk" });
    expect(mails).toEqual([]);
    await expect(updateEventNotifying(db, await ctxOf("ali"), deliver, e.id, { location: "Bane 9" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(mails).toEqual([]);
  });

  it("nyt sted giver besked, og admin der selv ændrer, får ikke selv besked", async () => {
    const niklas = await ctxOf("niklas"); // admin og far til Emma
    await updateEventNotifying(db, niklas, deliver, training().id, { location: "Kunstgræsbanen" });
    expect(mails.map((m) => m.to)).not.toContain(mailOf("niklas"));
    expect(mails).toHaveLength(5);
    expect(mails[0].text).toContain("Sted: Bane 3 -> Kunstgræsbanen");
  });

  it("giver ingen besked om aktiviteter der allerede er begyndt", async () => {
    const mette = await ctxOf("mette");
    await updateEventNotifying(db, mette, deliver, demo.events.u9PastMatch.id, { location: "Et andet sted" });
    expect(mails).toEqual([]);
  });
});

describe("kanaler", () => {
  it("SMS er opt-in og kræver et gyldigt mobilnummer", async () => {
    const sofie = await ctxOf("sofie");
    expect((await getNotificationPrefs(db, sofie.userId)).prefs.event_change).toEqual({ mail: true, sms: false });
    await sql`update profiles set phone = 'ring til mig' where id = ${demo.users.sofie.profile.id}`;
    await expect(setNotificationPref(db, sofie, "event_change", "sms", true)).rejects.toThrow(/mobilnummer/);
    await sql`update profiles set phone = '30 12 34 56' where id = ${demo.users.sofie.profile.id}`;
    await setNotificationPref(db, sofie, "event_change", "sms", true);
    expect((await getNotificationPrefs(db, sofie.userId)).prefs.event_change.sms).toBe(true);
    await expect(setNotificationPref(db, sofie, "findes_ikke", "mail", true)).rejects.toThrow(/Ukendt/);
    await expect(setNotificationPref(db, sofie, "event_change", "duer", true)).rejects.toThrow(/Ukendt/);
  });

  it("sender SMS til dem der har valgt det, og springer mail over for dem der har slået den fra", async () => {
    await setNotificationPref(db, await ctxOf("sofie"), "event_change", "sms", true);
    await setNotificationPref(db, await ctxOf("ali"), "event_change", "mail", false);
    await updateEventNotifying(db, await ctxOf("mette"), deliver, training().id, { location: "Bane 4" });
    expect(mails.map((m) => m.to)).not.toContain(mailOf("ali"));
    expect(mails).toHaveLength(5);
    expect(texts).toHaveLength(1);
    expect(texts[0].to).toBe("4530123456");
    expect(texts[0].text).toMatch(/^HoldLiv U9 piger: .* nyt sted Bane 4$/);
  });

  it("noterer SMS som sprunget over, når der ingen udbyder er, eller nummeret mangler", async () => {
    await setNotificationPref(db, await ctxOf("sofie"), "event_change", "sms", true);
    const noSms: Deliver = { ...deliver, sms: null };
    await updateEventNotifying(db, await ctxOf("mette"), noSms, training().id, { location: "Bane 5" });
    const sofie = await ctxOf("sofie");
    const sms = (await sql`select status, error from notifications where user_id = ${sofie.userId} and channel = 'sms' order by created_at desc limit 1`)[0];
    expect(sms).toMatchObject({ status: "skipped", error: "Ingen SMS-udbyder er sat op" });
    await sql`update profiles set phone = null where id = ${demo.users.sofie.profile.id}`;
    await updateEventNotifying(db, await ctxOf("mette"), deliver, training().id, { location: "Bane 6" });
    const sms2 = (await sql`select status, error from notifications where user_id = ${sofie.userId} and channel = 'sms' order by created_at desc limit 1`)[0];
    expect(sms2).toMatchObject({ status: "skipped", error: "Intet gyldigt mobilnummer" });
    await sql`update profiles set phone = '30 12 34 56' where id = ${demo.users.sofie.profile.id}`;
  });

  it("en fejl hos mailudbyderen stopper hverken ændringen eller de andre beskeder", async () => {
    failMailFor = mailOf("anne");
    const e = await updateEventNotifying(db, await ctxOf("mette"), deliver, training().id, { location: "Bane 7" });
    expect(e.location).toBe("Bane 7");
    expect(mails.map((m) => m.to)).not.toContain(mailOf("anne"));
    expect(mails.length).toBe(5);
    const failed = await db.select().from(notifications).where(eq(notifications.status, "failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe("Mailudbyderen er nede");
  });

  it("sender ikke den samme besked to gange, når der er en dedupe-nøgle", async () => {
    const [r] = await recipientsOfPlayers(db, [demo.kids.noor.id]);
    const msg = { kind: "event_change" as const, subject: "Test", body: "Test", sms: "Test", dedupeKey: "test-1" };
    expect((await notifyUsers(db, deliver, [r], msg)).sent).toBeGreaterThan(0);
    expect(await notifyUsers(db, deliver, [r], msg)).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(mails).toHaveLength(1);
  });
});

describe("aflysninger", () => {
  it("giver besked om en enkelt aflysning og om at den er genoptaget", async () => {
    const mette = await ctxOf("mette");
    await setEventCancelledNotifying(db, mette, deliver, demo.events.u9Match.id, true);
    expect(mails).toHaveLength(6);
    expect(mails[0].subject).toMatch(/^Aflyst: .*U9 piger/);
    expect(mails[0].text).toMatch(/er aflyst\./);
    mails.length = 0;
    await setEventCancelledNotifying(db, mette, deliver, demo.events.u9Match.id, false);
    expect(mails[0].subject).toMatch(/^Genoptaget:/);
    expect(mails[0].text).toMatch(/er ikke aflyst alligevel\./);
  });

  it("gentagen aflysning giver ingen ny besked og rører ikke den første aflysning", async () => {
    const mette = await ctxOf("mette");
    const id = demo.events.u9Match.id;
    await setEventCancelledNotifying(db, mette, deliver, id, true);
    const [{ cancelled_at: first }] = await sql`select cancelled_at from events where id = ${id}`;
    mails.length = 0;
    const again = await setEventCancelledNotifying(db, await ctxOf("mette"), { ...deliver }, id, true);
    expect(again).toEqual([]);
    expect(mails).toEqual([]);
    const [{ cancelled_at: after }] = await sql`select cancelled_at from events where id = ${id}`;
    expect(after).toEqual(first);
    await setEventCancelledNotifying(db, mette, deliver, id, false);
    mails.length = 0;
    await setEventCancelledNotifying(db, mette, deliver, id, false);
    expect(mails).toEqual([]);
  });

  it("genoptager man resten af en serie, høres kun om dem, der var aflyst", async () => {
    const mette = await ctxOf("mette");
    await setEventCancelledNotifying(db, mette, deliver, training().id, true);
    mails.length = 0;
    const res = await setEventCancelledNotifying(db, mette, deliver, training().id, false, "following");
    expect(res).toHaveLength(1);
    expect(mails).toHaveLength(6);
    expect(mails[0].subject).toMatch(/^Genoptaget: Træning, U9 piger$/);
  });

  it("samler en hel serie i én besked pr. familie", async () => {
    const mette = await ctxOf("mette");
    const res = await setEventCancelledNotifying(db, mette, deliver, training().id, true, "following");
    expect(res.length).toBeGreaterThan(5);
    expect(mails).toHaveLength(6); // én pr. familie, ikke én pr. aktivitet
    expect(mails[0].subject).toMatch(/aktiviteter, U9 piger$/);
    expect(mails[0].text).toMatch(/og \d+ flere/);
    expect(mails[0].text.match(/^- /gm)).toHaveLength(5);
  });

  it("kun trænere og admin kan aflyse, og så sendes intet", async () => {
    mails.length = 0;
    await expect(setEventCancelledNotifying(db, await ctxOf("ali"), deliver, demo.events.u9Match.id, true)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mails).toEqual([]);
  });

  it("viser mine seneste beskeder", async () => {
    await updateEventNotifying(db, await ctxOf("mette"), deliver, training().id, { location: "Bane 9" });
    const list = await listMyNotifications(db, await ctxOf("sofie"));
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].createdAt >= list[list.length - 1].createdAt).toBe(true);
  });
});

describe("påmindelser om ubesvarede aktiviteter", () => {
  const match = () => demo.events.u9Match;
  const deadline = () => match().responseDeadline!;
  const at = (hoursFromDeadline: number) => new Date(deadline().getTime() + hoursFromDeadline * 3600_000);
  const matchMails = () => mails.filter((m) => m.subject.includes("Bryrup"));

  it("venter, til der er et døgn til svarfristen", async () => {
    await sendUnansweredReminders(db, deliver, at(-30));
    expect(matchMails()).toEqual([]);
  });

  it("sender til dem, der mangler svar, og kun én gang", async () => {
    const first = await sendUnansweredReminders(db, deliver, at(-20));
    const toNiklas = matchMails().filter((m) => m.to === mailOf("niklas"));
    expect(toNiklas).toHaveLength(1);
    expect(toNiklas[0].subject).toMatch(/^Husk at svare: Kamp: Kamp mod Bryrup IF, U9 piger/);
    expect(toNiklas[0].text).toContain("Emma");
    expect(first.sent).toBe(matchMails().length + mails.filter((m) => !m.subject.includes("Bryrup")).length);
    const count = mails.length;
    await sendUnansweredReminders(db, deliver, at(-10));
    expect(mails).toHaveLength(count);
  });

  it("holder op, når fristen er gået, og følger kanalvalget", async () => {
    await sendUnansweredReminders(db, deliver, at(1));
    expect(matchMails()).toEqual([]);
    await setNotificationPref(db, await ctxOf("niklas"), "event_reminder", "mail", false);
    await sendUnansweredReminders(db, deliver, at(-5));
    expect(matchMails().map((m) => m.to)).not.toContain(mailOf("niklas"));
  });

  it("minder ikke om aflyste aktiviteter eller dem, man har svaret på", async () => {
    await sql`delete from notifications`;
    await setNotificationPref(db, await ctxOf("niklas"), "event_reminder", "mail", true);
    await sql`update events set cancelled_at = now() where id = ${match().id}`;
    await sendUnansweredReminders(db, deliver, at(-5));
    expect(matchMails()).toEqual([]);
    await sql`delete from notifications`;
    await sql`update events set cancelled_at = null where id = ${match().id}`;
    await sql`insert into event_responses (event_id, profile_id, status, responded_by_user_id)
      select ${match().id}, p.id, 'yes', ${demo.users.niklas.user.id} from profiles p where p.first_name = 'Emma'`;
    await sendUnansweredReminders(db, deliver, at(-5));
    expect(matchMails().map((m) => m.to)).not.toContain(mailOf("niklas"));
  });
});
