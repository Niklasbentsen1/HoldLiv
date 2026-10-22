// Demodata der viser Niklas' eksempel: én profil med flere roller.
import type { Db } from "./client";
import { loadAccessContext } from "../auth/context";
import {
  addClubMember,
  addTeamMember,
  createChildProfile,
  createClub,
  createEvent,
  createTeam,
  grantClubAdmin,
  registerUser,
} from "../services";

const inDays = (days: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
};

export async function seedDemo(db: Db) {
  const niklas = await registerUser(db, "niklas@holdliv.test", { firstName: "Niklas", lastName: "Bentsen", birthDate: "1990-04-12" });
  const mette = await registerUser(db, "mette@holdliv.test", { firstName: "Mette", lastName: "Holm", birthDate: "1985-09-03" });
  const jonas = await registerUser(db, "jonas@holdliv.test", { firstName: "Jonas", lastName: "Krogh", birthDate: "1998-01-20" });
  const karen = await registerUser(db, "karen@holdliv.test", { firstName: "Karen", lastName: "Lund", birthDate: "1979-06-30" });

  // Karen opretter foreningen og gør Niklas til bestyrelsesmedlem (admin).
  const club = await createClub(db, await loadAccessContext(db, karen.user.id), "Holdliv IF", "holdliv-if");
  // Rettighederne er et øjebliksbillede pr. forespørgsel, så de hentes igen efter rolleændringer.
  const karenCtx = await loadAccessContext(db, karen.user.id);
  await grantClubAdmin(db, karenCtx, club.id, niklas.profile.id, "Bestyrelsesmedlem");

  // Niklas opretter sin datters profil.
  const niklasCtx = await loadAccessContext(db, niklas.user.id);
  const emma = await createChildProfile(db, niklasCtx, { firstName: "Emma", lastName: "Bentsen", birthDate: "2017-08-14" });

  for (const p of [mette.profile, jonas.profile, emma]) await addClubMember(db, karenCtx, club.id, p.id);

  const u9 = await createTeam(db, karenCtx, club.id, "U9 piger", "2026/27");
  const senior = await createTeam(db, karenCtx, club.id, "Senior herrer", "2026/27");
  await addTeamMember(db, karenCtx, u9.id, mette.profile.id, "coach");
  await addTeamMember(db, karenCtx, senior.id, niklas.profile.id, "player");
  await addTeamMember(db, karenCtx, senior.id, jonas.profile.id, "player");

  // Mette er træner og tilføjer selv Emma til holdet.
  const metteCtx = await loadAccessContext(db, mette.user.id);
  await addTeamMember(db, metteCtx, u9.id, emma.id, "player");

  const u9Training = await createEvent(db, metteCtx, u9.id, { type: "training", title: "Træning", startsAt: inDays(2, 17), location: "Bane 3" });
  const u9Match = await createEvent(db, metteCtx, u9.id, { type: "match", title: "Kamp mod Bryrup IF", startsAt: inDays(5, 10), location: "Udebane" });
  const seniorTraining = await createEvent(db, karenCtx, senior.id, { type: "training", title: "Træning", startsAt: inDays(1, 19), location: "Bane 1" });

  return {
    club,
    users: { niklas, mette, jonas, karen },
    emma,
    teams: { u9, senior },
    events: { u9Training, u9Match, seniorTraining },
  };
}
