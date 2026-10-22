// Demoklubben "Skovby IF". Opdigtet, men realistisk: tre hold, trænere, forældre og børn,
// faste træninger tre uger tilbage og seks uger frem, kampe og svar.
// Den viser også Niklas' eksempel: én profil med flere roller.
import type { Db } from "./client";
import { eventResponses } from "./schema";
import { loadAccessContext } from "../auth/context";
import {
  addClubMember,
  addGuardian,
  addTeamMember,
  createChildProfile,
  createClub,
  createEvent,
  createEventSeries,
  createTeam,
  grantClubAdmin,
  registerUser,
  type PersonInput,
} from "../services";
import { TIME_ZONE, zonedTime } from "../lib/time";

/** Dato i dansk tid, et antal dage fra i dag. */
function dayAt(now: Date, days: number, hour: number, minute = 0) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now).split("-").map(Number);
  return zonedTime(y, m, d + days, hour, minute);
}

/** Første dato på en given ugedag (0 = søndag) fra et antal dage fra i dag. */
function nextWeekday(now: Date, fromDays: number, weekday: number, hour: number, minute = 0) {
  for (let i = fromDays; i < fromDays + 7; i++) {
    const d = dayAt(now, i, hour, minute);
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short" }).format(d);
    if (["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd) === weekday) return d;
  }
  throw new Error("unreachable");
}

const hours = (d: Date, h: number) => new Date(d.getTime() + h * 3600_000);

// Forudsigelig "tilfældighed", så demoen ser ens ud hver gang.
function pick(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}
const NO_REASONS = ["Syg", "Til fødselsdag", "Ferie med familien", "Tandlæge", "Skal til koncert"];

export async function seedDemo(db: Db, now = new Date()) {
  const adult = (email: string, p: PersonInput) => registerUser(db, email, p);
  const niklas = await adult("niklas@holdliv.test", { firstName: "Niklas", lastName: "Bentsen", birthDate: "1990-04-12", phone: "20 11 22 33" });
  const mette = await adult("mette@holdliv.test", { firstName: "Mette", lastName: "Holm", birthDate: "1985-09-03", phone: "21 44 55 66" });
  const jonas = await adult("jonas@holdliv.test", { firstName: "Jonas", lastName: "Krogh", birthDate: "1998-01-20" });
  const karen = await adult("karen@holdliv.test", { firstName: "Karen", lastName: "Lund", birthDate: "1979-06-30" });
  const peter = await adult("peter@holdliv.test", { firstName: "Peter", lastName: "Dam", birthDate: "1982-11-02" });
  const sofie = await adult("sofie@holdliv.test", { firstName: "Sofie", lastName: "Bak", birthDate: "1988-02-17", phone: "30 12 34 56" });
  const ali = await adult("ali@holdliv.test", { firstName: "Ali", lastName: "Hassan", birthDate: "1987-07-09", phone: "40 98 76 54" });
  const anne = await adult("anne@holdliv.test", { firstName: "Anne", lastName: "Møller", birthDate: "1986-05-25", phone: "50 23 45 67" });
  const lars = await adult("lars@holdliv.test", { firstName: "Lars", lastName: "Møller", birthDate: "1984-12-01" });
  const henrik = await adult("henrik@holdliv.test", { firstName: "Henrik", lastName: "Juul", birthDate: "1983-03-14", phone: "60 11 00 99" });

  // Karen opretter foreningen og gør Niklas til bestyrelsesmedlem (admin).
  const club = await createClub(db, await loadAccessContext(db, karen.user.id, now), "Skovby IF", "skovby-if");
  // Rettighederne er et øjebliksbillede pr. forespørgsel, så de hentes igen efter rolleændringer.
  const karenCtx = await loadAccessContext(db, karen.user.id, now);
  await grantClubAdmin(db, karenCtx, club.id, niklas.profile.id, "Bestyrelsesmedlem");

  // Forældrene opretter selv deres børns profiler.
  const child = async (parent: typeof niklas, firstName: string, birthDate: string) =>
    createChildProfile(db, await loadAccessContext(db, parent.user.id, now), { firstName, lastName: parent.profile.lastName, birthDate });
  const emma = await child(niklas, "Emma", "2017-08-14");
  const ida = await child(sofie, "Ida", "2017-03-02");
  const lukas = await child(sofie, "Lukas", "2015-10-30");
  const noor = await child(ali, "Noor", "2017-11-21");
  const freja = await child(anne, "Freja", "2018-01-09");
  const kasper = await child(anne, "Kasper", "2015-06-18");
  const alma = await child(henrik, "Alma", "2017-05-05");
  const oliver = await child(henrik, "Oliver", "2016-02-27");
  const william = await child(mette, "William", "2015-09-12");
  // Begge forældre er værger for Freja og Kasper.
  const anneCtx = await loadAccessContext(db, anne.user.id, now);
  await addGuardian(db, anneCtx, freja.id, lars.profile.id);
  await addGuardian(db, anneCtx, kasper.id, lars.profile.id);

  const adults = [niklas, mette, jonas, peter, sofie, ali, anne, lars, henrik].map((a) => a.profile);
  const kids = [emma, ida, lukas, noor, freja, kasper, alma, oliver, william];
  for (const p of [...adults, ...kids]) await addClubMember(db, karenCtx, club.id, p.id);

  const u9 = await createTeam(db, karenCtx, club.id, "U9 piger", "2026/27");
  const u11 = await createTeam(db, karenCtx, club.id, "U11 drenge", "2026/27");
  const senior = await createTeam(db, karenCtx, club.id, "Senior herrer", "2026/27");
  await addTeamMember(db, karenCtx, u9.id, mette.profile.id, "coach");
  await addTeamMember(db, karenCtx, u11.id, jonas.profile.id, "coach");
  await addTeamMember(db, karenCtx, senior.id, peter.profile.id, "coach");
  for (const p of [niklas, jonas, lars, ali, henrik]) await addTeamMember(db, karenCtx, senior.id, p.profile.id, "player");

  // Trænerne tilføjer selv børnene til deres hold.
  const metteCtx = await loadAccessContext(db, mette.user.id, now);
  const jonasCtx = await loadAccessContext(db, jonas.user.id, now);
  const peterCtx = await loadAccessContext(db, peter.user.id, now);
  for (const k of [emma, ida, noor, freja, alma]) await addTeamMember(db, metteCtx, u9.id, k.id, "player");
  for (const k of [lukas, kasper, oliver, william]) await addTeamMember(db, jonasCtx, u11.id, k.id, "player");

  // Faste træninger fra tre uger siden til seks uger frem.
  const until = dayAt(now, 42, 23);
  const series = async (ctx: typeof metteCtx, teamId: string, weekday: number, h: number, m: number, len: number, location: string) => {
    const startsAt = nextWeekday(now, -21, weekday, h, m);
    return createEventSeries(db, ctx, teamId, { type: "training", title: "Træning", startsAt, endsAt: hours(startsAt, len), location }, until);
  };
  await series(metteCtx, u9.id, 2, 17, 0, 1.25, "Bane 3");
  await series(metteCtx, u9.id, 4, 17, 0, 1.25, "Bane 3");
  await series(jonasCtx, u11.id, 1, 17, 30, 1.5, "Bane 2");
  await series(jonasCtx, u11.id, 3, 17, 30, 1.5, "Bane 2");
  await series(peterCtx, senior.id, 2, 19, 0, 1.5, "Bane 1");
  await series(peterCtx, senior.id, 4, 19, 0, 1.5, "Bane 1");

  const u9MatchStart = nextWeekday(now, 3, 6, 10);
  const u9Match = await createEvent(db, metteCtx, u9.id, {
    type: "match",
    title: "Kamp mod Bryrup IF",
    startsAt: u9MatchStart,
    endsAt: hours(u9MatchStart, 2),
    location: "Bryrup Stadion",
    description: "Mødetid 9.15 ved klubhuset. Vi kører sammen. Husk rød trøje og drikkedunk.",
    responseDeadline: hours(u9MatchStart, -38),
  });
  const u9PastMatch = await createEvent(db, metteCtx, u9.id, {
    type: "match",
    title: "Kamp mod Gjern IF",
    startsAt: nextWeekday(now, -10, 6, 10),
    location: "Hjemmebane, bane 3",
  });
  const u11MatchStart = nextWeekday(now, 4, 0, 11);
  await createEvent(db, jonasCtx, u11.id, { type: "match", title: "Kamp mod Them B&I", startsAt: u11MatchStart, endsAt: hours(u11MatchStart, 2), location: "Them Hallen", responseDeadline: hours(u11MatchStart, -48) });
  const seniorMatchStart = nextWeekday(now, 2, 0, 14);
  await createEvent(db, peterCtx, senior.id, { type: "match", title: "Serie 3: Skovby IF – Hammel GF", startsAt: seniorMatchStart, endsAt: hours(seniorMatchStart, 2), location: "Hjemmebane, bane 1" });
  await createEvent(db, karenCtx, u9.id, { type: "other", title: "Forældremøde", startsAt: dayAt(now, 12, 19), location: "Klubhuset", description: "Vi planlægger stævnet i marts og fordeler kørsel." });

  // Svar: de fleste kommer, nogle melder fra med en grund, enkelte svarer ikke.
  const guardianOf = new Map<string, string>([
    [emma.id, niklas.user.id], [ida.id, sofie.user.id], [lukas.id, sofie.user.id], [noor.id, ali.user.id],
    [freja.id, anne.user.id], [kasper.id, lars.user.id], [alma.id, henrik.user.id], [oliver.id, henrik.user.id],
    [william.id, mette.user.id],
  ]);
  const playerUser = new Map([niklas, jonas, lars, ali, henrik].map((p) => [p.profile.id, p.user.id]));
  const rosters = [
    { teamId: u9.id, players: [emma, ida, noor, freja, alma].map((k) => k.id) },
    { teamId: u11.id, players: [lukas, kasper, oliver, william].map((k) => k.id) },
    { teamId: senior.id, players: [niklas, jonas, lars, ali, henrik].map((p) => p.profile.id) },
  ];
  const allEvents = await db.query.events.findMany();
  const rows = [];
  for (const e of allEvents) {
    const roster = rosters.find((r) => r.teamId === e.teamId)!;
    const past = e.startsAt.getTime() < now.getTime();
    const soon = e.startsAt.getTime() < now.getTime() + 8 * 86_400_000;
    if (!past && !soon) continue;
    for (const profileId of roster.players) {
      const r = pick(`${e.startsAt.toISOString()}${profileId}`);
      // Kommende aktiviteter: kun omkring halvdelen har svaret endnu.
      if (!past && r > 0.55) continue;
      if (past && r > 0.93) continue;
      const status = r < 0.12 ? "no" : r < 0.18 ? "maybe" : "yes";
      const by = guardianOf.get(profileId) ?? playerUser.get(profileId)!;
      rows.push({
        eventId: e.id,
        profileId,
        status: status as "yes" | "no" | "maybe",
        comment: status === "no" ? NO_REASONS[Math.floor(r * 100) % NO_REASONS.length] : null,
        respondedByUserId: by,
        respondedAt: new Date(Math.min(e.startsAt.getTime(), now.getTime()) - (1 + r * 3) * 86_400_000),
      });
    }
  }
  // Emma har ikke svaret på næste kamp endnu, så Niklas kan prøve det selv.
  const demoRows = rows.filter((r) => !(r.eventId === u9Match.id && r.profileId === emma.id));
  if (demoRows.length) await db.insert(eventResponses).values(demoRows);

  const upcoming = (teamId: string) =>
    allEvents.filter((e) => e.teamId === teamId && e.type === "training" && e.startsAt > now).sort((a, b) => +a.startsAt - +b.startsAt)[0];

  return {
    club,
    users: { niklas, mette, jonas, karen, peter, sofie, ali, anne, lars, henrik },
    emma,
    kids: { emma, ida, lukas, noor, freja, kasper, alma, oliver, william },
    teams: { u9, u11, senior },
    events: { u9Training: upcoming(u9.id), u9Match, u9PastMatch, seniorTraining: upcoming(senior.id) },
  };
}
