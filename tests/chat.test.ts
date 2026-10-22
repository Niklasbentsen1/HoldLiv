// Holdchat: automatiske grupper, adgang, ulæste, sletning og beskeder, mod en rigtig Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { addClubMember, addTeamMember, registerUser, deleteMessage, getChat, getEventChat, listChats, postMessage, setTeamModule, type Deliver } from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
const mails: { to: string; subject: string; text: string }[] = [];
const deliver: Deliver = {
  baseUrl: "https://holdliv.test",
  mail: async (to, subject, text) => {
    mails.push({ to, subject, text });
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
beforeEach(async () => {
  mails.length = 0;
  await sql`delete from notifications`;
});

const ctxOf = (key: keyof typeof demo.users) => loadAccessContext(db, demo.users[key].user.id);
const u9 = () => demo.teams.u9.id;
const senior = () => demo.teams.senior.id;
const thread = async (who: keyof typeof demo.users, teamId: string, kind: string) =>
  (await listChats(db, await ctxOf(who), teamId)).find((c) => c.kind === kind)!.id;

describe("modulet", () => {
  it("er lukket, til foreningen slår det til for holdet", async () => {
    await expect(listChats(db, await ctxOf("mette"), u9())).rejects.toThrow(/ikke slået til/);
    await setTeamModule(db, await ctxOf("karen"), u9(), "chat", true);
    await setTeamModule(db, await ctxOf("karen"), senior(), "chat", true);
    expect(await listChats(db, await ctxOf("mette"), u9())).toHaveLength(3);
  });
});

describe("hvem ser hvilke samtaler", () => {
  const kinds = async (who: keyof typeof demo.users, teamId: string) => (await listChats(db, await ctxOf(who), teamId)).map((c) => c.kind);

  it("trænere ser alle tre, forældre ser hele holdet og trænere + forældre", async () => {
    expect(await kinds("mette", u9())).toEqual(["all", "coaches_parents", "coaches"]);
    expect(await kinds("niklas", u9())).toEqual(["all", "coaches_parents"]); // far til Emma
  });

  it("voksne spillere ser kun hele holdet", async () => {
    expect(await kinds("niklas", senior())).toEqual(["all"]); // spiller på seniorholdet
    expect(await kinds("peter", senior())).toEqual(["all", "coaches_parents", "coaches"]);
  });

  it("andre ser ingenting og kan ikke åbne en samtale ved at kende dens id", async () => {
    await expect(listChats(db, await ctxOf("peter"), u9())).rejects.toBeTruthy();
    const coachesThread = await thread("mette", u9(), "coaches");
    await expect(getChat(db, await ctxOf("niklas"), coachesThread)).rejects.toThrow(/findes ikke/);
    await expect(postMessage(db, await ctxOf("niklas"), deliver, coachesThread, "Hej")).rejects.toThrow(/findes ikke/);
    await expect(getChat(db, await ctxOf("peter"), await thread("mette", u9(), "all"))).rejects.toBeTruthy();
  });
});

describe("beskeder", () => {
  it("afviser tomme og for lange beskeder", async () => {
    const t = await thread("mette", u9(), "all");
    await expect(postMessage(db, await ctxOf("mette"), deliver, t, "   ")).rejects.toThrow(/Skriv en besked/);
    await expect(postMessage(db, await ctxOf("mette"), deliver, t, "x".repeat(2001))).rejects.toThrow(/for lang/);
  });

  it("viser navn og rolle, og ulæste tælles for de andre, ikke for forfatteren", async () => {
    const t = await thread("mette", u9(), "all");
    await postMessage(db, await ctxOf("mette"), deliver, t, "Husk at tage drikkedunk med lørdag.");
    await postMessage(db, await ctxOf("niklas"), deliver, t, "Tak, det gør vi.");
    expect((await listChats(db, await ctxOf("sofie"), u9())).find((c) => c.kind === "all")!.unread).toBe(2);
    expect((await listChats(db, await ctxOf("niklas"), u9())).find((c) => c.kind === "all")!.unread).toBe(0); // at svare tæller som at have læst
    const chat = await getChat(db, await ctxOf("sofie"), t);
    expect(chat.messages.map((m) => [m.authorName, m.authorLabel])).toEqual([
      ["Mette Holm", "Træner"],
      ["Niklas Bentsen", "Forælder til Emma"],
    ]);
    expect((await listChats(db, await ctxOf("sofie"), u9())).find((c) => c.kind === "all")!.unread).toBe(0);
  });

  it("giver de andre medlemmer besked, højst én gang pr. samtale hvert tiende minut", async () => {
    await sql`insert into notification_prefs (user_id, kind, channel, enabled) select id, 'chat', 'mail', true from users`;
    const t = await thread("mette", u9(), "coaches_parents");
    await postMessage(db, await ctxOf("mette"), deliver, t, "Første");
    await postMessage(db, await ctxOf("mette"), deliver, t, "Anden");
    const to = mails.map((m) => m.to).sort();
    expect(to).toEqual(["ali", "anne", "henrik", "lars", "niklas", "sofie"].map((n) => `${n}@holdliv.test`));
    expect(mails[0].subject).toBe("Ny besked i U9 piger, Trænere og forældre");
    expect(mails[0].text).toContain(`/hold/${u9()}/chat?samtale=${t}`);
  });

  it("sender ikke mail som standard, fordi chat er mange små beskeder", async () => {
    await sql`delete from notification_prefs`;
    await postMessage(db, await ctxOf("mette"), deliver, await thread("mette", u9(), "all"), "Ingen mail");
    expect(mails).toEqual([]);
  });

  it("holder de voksne spillere ude af trænere og forældre, og forældre ude af trænere", async () => {
    await sql`insert into notification_prefs (user_id, kind, channel, enabled) select id, 'chat', 'mail', true from users`;
    await postMessage(db, await ctxOf("peter"), deliver, await thread("peter", senior(), "coaches"), "Kun os trænere");
    expect(mails).toEqual([]); // Peter er seniorholdets eneste træner
    await postMessage(db, await ctxOf("peter"), deliver, await thread("peter", senior(), "all"), "Hele holdet");
    expect(mails.map((m) => m.to).sort()).toEqual(["ali", "henrik", "jonas", "lars", "niklas"].map((n) => `${n}@holdliv.test`));
  });
});

describe("børn med eget login", () => {
  it("får hverken adgang eller besked, heller ikke en spiller uden fødselsdato", async () => {
    const karen = await ctxOf("karen");
    const teen = await registerUser(db, "teen@holdliv.test", { firstName: "Teen", lastName: "Test", birthDate: "2030-01-01" });
    const nobd = await registerUser(db, "nobd@holdliv.test", { firstName: "Nobd", lastName: "Test" });
    const adult = await registerUser(db, "voksen@holdliv.test", { firstName: "Voksen", lastName: "Test", birthDate: "1995-01-01" });
    for (const p of [teen, nobd, adult]) {
      await addClubMember(db, karen, demo.club.id, p.profile.id);
      await addTeamMember(db, karen, u9(), p.profile.id, "player");
    }
    await sql`insert into notification_prefs (user_id, kind, channel, enabled) select id, 'chat', 'mail', true from users on conflict (user_id, kind, channel) do update set enabled = true`;
    for (const u of [teen, nobd]) expect(await listChats(db, await loadAccessContext(db, u.user.id), u9())).toEqual([]);
    expect((await listChats(db, await loadAccessContext(db, adult.user.id), u9())).map((c) => c.kind)).toEqual(["all"]);
    mails.length = 0;
    await postMessage(db, await ctxOf("mette"), deliver, await thread("mette", u9(), "all"), "Til hele holdet");
    const to = mails.map((m) => m.to);
    expect(to).toContain("voksen@holdliv.test");
    expect(to).not.toContain("teen@holdliv.test");
    expect(to).not.toContain("nobd@holdliv.test");
    await sql`delete from team_members where team_id = ${u9()} and profile_id in (${teen.profile.id}, ${nobd.profile.id}, ${adult.profile.id})`;
  });
});

describe("sletning", () => {
  it("forfatteren og trænerne kan slette, andre kan ikke, og pladsen bliver stående", async () => {
    const t = await thread("mette", u9(), "all");
    const a = await postMessage(db, await ctxOf("niklas"), deliver, t, "Min besked");
    const b = await postMessage(db, await ctxOf("sofie"), deliver, t, "Sofies besked");
    await expect(deleteMessage(db, await ctxOf("niklas"), b.id)).rejects.toThrow(/må du ikke/);
    await deleteMessage(db, await ctxOf("niklas"), a.id);
    await deleteMessage(db, await ctxOf("mette"), b.id);
    const chat = await getChat(db, await ctxOf("mette"), t);
    const mine = chat.messages.filter((m) => [a.id, b.id].includes(m.id));
    expect(mine.map((m) => [m.deleted, m.body])).toEqual([[true, null], [true, null]]);
    expect(mine.every((m) => !m.canDelete)).toBe(true);
  });
});

describe("aktivitetens chat", () => {
  it("oprettes én gang, kun for holdets medlemmer", async () => {
    const e = demo.events.u9Training.id;
    const id = await getEventChat(db, await ctxOf("niklas"), e);
    expect(await getEventChat(db, await ctxOf("mette"), e)).toBe(id);
    await postMessage(db, await ctxOf("niklas"), deliver, id, "Kan vi låne bolde?");
    const chat = await getChat(db, await ctxOf("mette"), id);
    expect(chat.name).toBe("Træning");
    expect(chat.messages).toHaveLength(1);
    await expect(getEventChat(db, await ctxOf("peter"), e)).rejects.toBeTruthy();
    expect(await sql`select 1 from chat_threads where event_id = ${e}`).toHaveLength(1);
  });
});
