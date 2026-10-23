// Demoklubben "Skovby IF". Opdigtet, men realistisk: tre hold, trænere, forældre og børn,
// faste træninger tre uger tilbage og seks uger frem, kampe og svar.
// Den viser også Niklas' eksempel: én profil med flere roller.
import type { Db } from "./client";
import { eq } from "drizzle-orm";
import { eventResponses, pollOptions } from "./schema";
import { addDays, localDate } from "../lib/money";
import { mockProvider } from "../lib/payments";
import { loadAccessContext } from "../auth/context";
import {
  addClubMember,
  addFundEntry,
  createScreen,
  createPost,
  createTicketEvent,
  saveSignupSettings,
  saveSiteSettings,
  uploadDocument,
  createPoll,
  vote,
  addMatchEvent,
  recordResult,
  saveLineup,
  saveReport,
  setLineupPublished,
  setTeamModule,
  updateModuleConfig,
  addGuardian,
  addTeamMember,
  createChildProfile,
  createClub,
  createEvent,
  createBooking,
  createShift,
  signUpForShift,
  createContract,
  sendContract,
  signContract,
  requireCertificate,
  giveCertificateConsent,
  recordWrittenConsent,
  markCertificateRequested,
  registerCertificateResult,
  createResource,
  createEventSeries,
  createTeam,
  completeCheckout,
  createFee,
  createSingleCharge,
  grantClubAdmin,
  grantTreasurerByEmail,
  listCharges,
  registerManualPayment,
  runCharges,
  setTeamDefaultFee,
  startCheckout,
  updateMembership,
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
  // Kontingent: Sofie er kasserer og sætter satserne op, før spillerne kommer på holdene,
  // så de automatisk får holdets kontingent.
  await grantTreasurerByEmail(db, karenCtx, club.id, "sofie@holdliv.test");
  const sofieCtx = await loadAccessContext(db, sofie.user.id, now);
  const kidsFee = await createFee(db, sofieCtx, club.id, { name: "Børn under 13 år", amountOre: 65000, interval: "half_year" });
  const seniorFee = await createFee(db, sofieCtx, club.id, { name: "Senior", amountOre: 110000, interval: "half_year" });
  const passiveFee = await createFee(db, sofieCtx, club.id, { name: "Passivt medlem", amountOre: 20000, interval: "year" });
  await setTeamDefaultFee(db, sofieCtx, u9.id, kidsFee.id);
  await setTeamDefaultFee(db, sofieCtx, u11.id, kidsFee.id);
  await setTeamDefaultFee(db, sofieCtx, senior.id, seniorFee.id);

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
    const soon = e.startsAt.getTime() < now.getTime() + 10 * 86_400_000;
    if (!past && !soon) continue;
    for (const profileId of roster.players) {
      const r = pick(`${e.startsAt.toISOString()}${profileId}`);
      // Kommende aktiviteter: kun omkring halvdelen har svaret endnu.
      if (!past && r > 0.55) continue;
      if (past && r > 0.93) continue;
      const status = r < 0.12 ? "no" : r < 0.18 ? "maybe" : "yes";
      const by = guardianOf.get(profileId) ?? playerUser.get(profileId)!;
      const respondedAt = new Date(Math.min(e.startsAt.getTime(), now.getTime()) - (1 + r * 3) * 86_400_000);
      rows.push({
        eventId: e.id,
        profileId,
        status: status as "yes" | "no" | "maybe",
        comment: status === "no" ? NO_REASONS[Math.floor(r * 100) % NO_REASONS.length] : null,
        respondedByUserId: by,
        respondedAt,
        yesSince: status === "yes" ? respondedAt : null,
      });
    }
  }
  // Emma har ikke svaret på næste kamp endnu, så Niklas kan prøve det selv.
  const demoRows = rows.filter((r) => !(r.eventId === u9Match.id && r.profileId === emma.id));
  if (demoRows.length) await db.insert(eventResponses).values(demoRows);

  // Kontingent for indeværende halvår. Fristen er overskredet, og de fleste har betalt.
  // Trænerne er gratister; Karen er passivt medlem.
  for (const p of [mette, jonas, peter]) await updateMembership(db, sofieCtx, club.id, p.profile.id, { exempt: true });
  await updateMembership(db, sofieCtx, club.id, karen.profile.id, { feeId: passiveFee.id });
  const today = localDate(now);
  const dueDate = addDays(today, -14);
  for (const fee of [kidsFee, seniorFee, passiveFee]) await runCharges(db, sofieCtx, fee.id, today, dueDate);
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const payerOf = new Map([...guardianOf, [karen.profile.id, karen.user.id]]);
  const open = await listCharges(db, sofieCtx, club.id, "open");
  for (const c of open) {
    // Emma mangler, så Niklas kan prøve at betale. Noor og Oliver er i restance.
    if ([emma.id, noor.id, oliver.id, ali.profile.id].includes(c.profileId)) continue;
    const r = pick(`kontingent${c.profileId}`);
    if (r < 0.3) {
      await registerManualPayment(db, { ...sofieCtx, now: daysAgo(20) }, c.id, "MobilePay til kassereren");
    } else {
      const payer = payerOf.get(c.profileId) ?? playerUser.get(c.profileId)!;
      const ctx = await loadAccessContext(db, payer, now);
      await startCheckout(db, ctx, c.id, mockProvider, "http://localhost:3000");
      const [{ providerRef }] = await db.query.payments.findMany({ where: (p, { eq }) => eq(p.chargeId, c.id) });
      await completeCheckout(db, providerRef!, { now: daysAgo(10 + Math.floor(r * 30)) });
    }
  }
  await createSingleCharge(db, sofieCtx, club.id, ida.id, { description: "Træningstrøje med navn", amountOre: 15000, dueDate: addDays(today, 10) });

  const upcoming = (teamId: string) =>
    allEvents.filter((e) => e.teamId === teamId && e.type === "training" && e.startsAt > now).sort((a, b) => +a.startsAt - +b.startsAt)[0];

  return {
    club,
    users: { niklas, mette, jonas, karen, peter, sofie, ali, anne, lars, henrik },
    emma,
    kids: { emma, ida, lukas, noor, freja, kasper, alma, oliver, william },
    teams: { u9, u11, senior },
    fees: { kids: kidsFee, senior: seniorFee, passive: passiveFee },
    events: { u9Training: upcoming(u9.id), u9Match, u9PastMatch, seniorTraining: upcoming(senior.id) },
  };
}

/** Kampe og opstilling i demoklubben: U9 har modulet slået til, en spillet kamp med referat og en kommende med opstilling. Bruges kun af db:seed. */
export async function seedMatchDemo(db: Db, demo: Awaited<ReturnType<typeof seedDemo>>, now = new Date()) {
  const karen = await loadAccessContext(db, demo.users.karen.user.id, now);
  const mette = await loadAccessContext(db, demo.users.mette.user.id, now);
  const u9 = demo.teams.u9.id;
  await setTeamModule(db, karen, u9, "matches", true);
  await updateModuleConfig(db, mette, u9, "matches", { startersCount: "4" });
  const { emma, ida, noor, freja, alma } = demo.kids;
  const past = demo.events.u9PastMatch.id;
  await saveLineup(db, mette, past, {
    opponent: "Gjern IF",
    formation: "1-2-1",
    entries: [
      { profileId: alma.id, slot: "start", position: "Målmand" },
      { profileId: ida.id, slot: "start", position: "Forsvar" },
      { profileId: noor.id, slot: "start", position: "Midtbane" },
      { profileId: emma.id, slot: "start", position: "Angreb" },
      { profileId: freja.id, slot: "bench" },
    ],
  });
  await setLineupPublished(db, mette, past, true);
  const after = { ...mette, now };
  await recordResult(db, after, past, { goalsFor: 4, goalsAgainst: 2, minutes: { [alma.id]: 40, [ida.id]: 40, [noor.id]: 35, [emma.id]: 30, [freja.id]: 25 } });
  await addMatchEvent(db, after, past, { kind: "goal", profileId: emma.id, assistProfileId: noor.id, minute: 6 });
  await addMatchEvent(db, after, past, { kind: "goal", profileId: emma.id, minute: 14 });
  await addMatchEvent(db, after, past, { kind: "goal", profileId: freja.id, assistProfileId: emma.id, minute: 31 });
  await addMatchEvent(db, after, past, { kind: "goal", profileId: noor.id, minute: 38 });
  await saveReport(db, mette, past, {
    text: "Flot sejr på hjemmebane. Vi kom hurtigt foran, og Alma i målet reddede flere store chancer. Freja scorede sit første mål for klubben, da hun kom ind. Næste gang øver vi at holde pladsen, når bolden er tabt.",
    publish: true,
  });
  await saveLineup(db, mette, demo.events.u9Match.id, {
    opponent: "Ry IF",
    entries: [
      { profileId: alma.id, slot: "start", position: "Målmand" },
      { profileId: freja.id, slot: "start" },
      { profileId: ida.id, slot: "start" },
      { profileId: emma.id, slot: "start" },
      { profileId: noor.id, slot: "bench" },
    ],
  });
}

/** Booking i demoklubben: en bane, en hal der skal godkendes og udstyr, og et par bookinger. Priserne er kun eksempler; foreningen sætter dem selv. Bruges kun af db:seed. */
export async function seedBookingDemo(db: Db, demo: Awaited<ReturnType<typeof seedDemo>>, now = new Date()) {
  const sofie = await loadAccessContext(db, demo.users.sofie.user.id, now);
  const mette = await loadAccessContext(db, demo.users.mette.user.id, now);
  const niklas = await loadAccessContext(db, demo.users.niklas.user.id, now);
  const club = demo.club.id;
  const bane = await createResource(db, sofie, club, { name: "Kunststofbane", kind: "court", description: "Kunstgræs med lys. Omklædning i klubhuset.", pricePerHourOre: 15000 });
  await createResource(db, sofie, club, { name: "Skovbyhallen", kind: "hall", description: "Hal til indendørs træning og fester.", pricePerHourOre: 30000, requiresApproval: true });
  const bolde = await createResource(db, sofie, club, { name: "Bolde", kind: "equipment", quantity: 20, description: "Match-bolde, str. 4 og 5." });
  await createBooking(db, mette, { resourceId: bane.id, teamId: demo.teams.u9.id, startsAt: dayAt(now, 3, 16), endsAt: dayAt(now, 3, 17, 30) });
  await createBooking(db, niklas, { resourceId: bane.id, startsAt: dayAt(now, 5, 18), endsAt: dayAt(now, 5, 19) });
  await createBooking(db, mette, { resourceId: bolde.id, teamId: demo.teams.u9.id, quantity: 8, startsAt: dayAt(now, 3, 16), endsAt: dayAt(now, 3, 17, 30) });
}

/** Vagtplan, kontrakter og børneattester i demoklubben. Beløbet i kontrakten er kun et eksempel; foreningen sætter det selv. Bruges kun af db:seed. */
export async function seedVolunteerDemo(db: Db, demo: Awaited<ReturnType<typeof seedDemo>>, now = new Date()) {
  const karen = await loadAccessContext(db, demo.users.karen.user.id, now);
  const mette = await loadAccessContext(db, demo.users.mette.user.id, now);
  const niklas = await loadAccessContext(db, demo.users.niklas.user.id, now);
  const peter = demo.users.peter;
  const club = demo.club.id;
  const kiosk = await createShift(db, karen, club, { title: "Kioskvagt ved hjemmekampen", location: "Klubhuset", startsAt: dayAt(now, 6, 9), endsAt: dayAt(now, 6, 12), slots: 3 });
  await createShift(db, mette, club, { title: "Kridt banen til U9-stævnet", teamId: demo.teams.u9.id, location: "Bane 3", startsAt: dayAt(now, 8, 16), endsAt: dayAt(now, 8, 17), slots: 2 });
  await createShift(db, karen, club, { title: "Opsyn ved børnestævnet", description: "Voksne på banen og i omklædningen.", startsAt: dayAt(now, 13, 8), endsAt: dayAt(now, 13, 14), slots: 4, requiresChildCertificate: true });
  await signUpForShift(db, niklas, kiosk.id);

  // Børneattester: Mette har en gyldig, Peters er bestilt, og Niklas mangler at give samtykke.
  const metteCert = await requireCertificate(db, karen, club, demo.users.mette.profile.id, "Træner U9 piger");
  await giveCertificateConsent(db, mette, metteCert);
  await markCertificateRequested(db, karen, metteCert);
  const today = new Date(now);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  await registerCertificateResult(db, karen, metteCert, { approved: true, issuedOn: iso(today), expiresOn: iso(new Date(today.getTime() + 3 * 365 * 86400000)) });
  const peterCert = await requireCertificate(db, karen, club, peter.profile.id, "Træner Senior herrer");
  await recordWrittenConsent(db, karen, peterCert);
  await markCertificateRequested(db, karen, peterCert);
  await requireCertificate(db, karen, club, demo.users.niklas.profile.id, "Hjælper ved børnestævnet");

  // Kontrakter: Mettes er underskrevet, Peters venter på underskrift.
  const start = iso(today);
  const end = iso(new Date(today.getTime() + 365 * 86400000));
  const mc = await createContract(db, karen, club, { profileId: demo.users.mette.profile.id, kind: "coach", title: "Trænerkontrakt U9 piger", body: "Mette er træner for U9 piger i sæsonen 2026/27 og følger foreningens retningslinjer for børn og unge.", startsOn: start, endsOn: end });
  await sendContract(db, karen, mc.id);
  await signContract(db, mette, mc.id, `${demo.users.mette.profile.firstName} ${demo.users.mette.profile.lastName}`);
  const pc = await createContract(db, karen, club, { profileId: peter.profile.id, kind: "coach", title: "Trænerkontrakt Senior herrer", body: "Peter er træner for Senior herrer i sæsonen 2026/27.", startsOn: start, endsOn: end });
  await sendContract(db, karen, pc.id);
}

/** Holdkasse på U9 i demoklubben: nogle indbetalinger og en udgift. Beløbene er opdigtede og kun til demoen. */
export async function seedTeamFundDemo(db: Db, demo: Awaited<ReturnType<typeof seedDemo>>, now = new Date()) {
  const karen = await loadAccessContext(db, demo.users.karen.user.id, now);
  const mette = await loadAccessContext(db, demo.users.mette.user.id, now);
  const u9 = demo.teams.u9.id;
  await setTeamModule(db, karen, u9, "teamfund", true);
  const today = localDate(now);
  for (const kid of [demo.kids.emma, demo.kids.ida, demo.kids.noor]) {
    await addFundEntry(db, mette, u9, { kind: "deposit", amountOre: 5000, description: "Indbetaling til sæsonafslutning", profileId: kid.id, entryDate: addDays(today, -14) });
  }
  await addFundEntry(db, mette, u9, { kind: "withdrawal", amountOre: 4200, description: "Frugt og vand til stævnet", entryDate: addDays(today, -3) });
}

/** En åben afstemning på U9 med et par stemmer. */
export async function seedPollDemo(db: Db, demo: Awaited<ReturnType<typeof seedDemo>>, now = new Date()) {
  const karen = await loadAccessContext(db, demo.users.karen.user.id, now);
  const mette = await loadAccessContext(db, demo.users.mette.user.id, now);
  const u9 = demo.teams.u9.id;
  await setTeamModule(db, karen, u9, "polls", true);
  const poll = await createPoll(db, mette, u9, { question: "Hvornår skal vi holde sæsonafslutning?", options: ["Fredag den 5. juni", "Lørdag den 6. juni", "Søndag den 7. juni"] });
  const [option] = await db.select().from(pollOptions).where(eq(pollOptions.pollId, poll.id)).orderBy(pollOptions.position);
  await vote(db, await loadAccessContext(db, demo.users.ali.user.id, now), poll.id, [option.id], demo.kids.noor.id);
}

/** Dokumentarkiv og en infoskærm i demoklubben. Filen er en lille opdigtet PDF. */
export async function seedArchiveDemo(db: Db, demo: Awaited<ReturnType<typeof seedDemo>>, now = new Date()) {
  const karen = await loadAccessContext(db, demo.users.karen.user.id, now);
  const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
  await uploadDocument(db, karen, demo.club.id, { audience: "club", title: "Vedtægter for Skovby IF", category: "Vedtægter", fileName: "vedtaegter.pdf", bytes: pdf });
  await uploadDocument(db, karen, demo.club.id, { audience: "board", title: "Referat fra bestyrelsesmødet", category: "Referater", fileName: "referat.pdf", bytes: pdf });
  await createScreen(db, karen, demo.club.id, { name: "Klubhuset", message: "Husk at tage skoene af i hallen" });
  await saveSiteSettings(db, karen, demo.club.id, {
    enabled: true,
    intro: "Skovby IF er en lokal idrætsforening for alle aldre. Vi spiller fodbold og har hold fra U9 til senior.",
    contact: "Formand Karen Holm, formand@skovby-if.test\nSkovbyhallen, Hallevej 1",
    showTeams: true,
    showCalendar: true,
  });
  await saveSignupSettings(db, karen, demo.club.id, { enabled: true, minAge: null, maxAge: null, terms: null });
  await createPost(db, karen, { mail: async () => {}, sms: null, baseUrl: "" }, { kind: "news", scope: `club:${demo.club.id}`, title: "Sæsonstart for alle hold", body: "Vi starter sæsonen i næste uge. Kom og vær med!", publicOnSite: true });
  await createTicketEvent(db, karen, demo.club.id, {
    name: "Hjemmekamp: Skovby IF mod Hammel GF",
    description: "Serie 3, hjemmebane. Der er kaffe og kage i klubhuset.",
    location: "Hjemmebane, bane 1",
    startsAt: new Date(now.getTime() + 5 * 86_400_000),
    priceOre: 5000,
    capacity: 200,
  });
}
