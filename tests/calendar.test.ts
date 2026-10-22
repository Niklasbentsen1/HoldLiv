import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { events } from "../src/db/schema";
import { loadAccessContext } from "../src/auth/context";
import { ForbiddenError } from "../src/auth/permissions";
import { toLocalInput, zonedTime } from "../src/lib/time";
import {
  addCoachByEmail,
  addGuardianByEmail,
  createEventSeries,
  findTeamByInvite,
  getAttendanceOverview,
  getEventDetail,
  getTeam,
  joinTeamByInvite,
  listFamily,
  listMyTeams,
  listTeamEvents,
  registerUser,
  respondToEvent,
  rotateInviteCode,
  setEventCancelled,
  createChildProfile,
} from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
beforeAll(async () => {
  await reset();
  demo = await seedDemo(db);
});
afterAll(() => sql.end());

const ctxOf = (key: keyof typeof demo.users, now?: Date) => loadAccessContext(db, demo.users[key].user.id, now);

describe("faste træninger", () => {
  it("holder klokkeslættet hen over skiftet til vintertid", async () => {
    const mette = await ctxOf("mette");
    const start = zonedTime(2026, 10, 20, 17, 0); // tirsdag før vintertid
    const created = await createEventSeries(
      db,
      mette,
      demo.teams.u9.id,
      { type: "training", title: "Målmandstræning", startsAt: start },
      zonedTime(2026, 11, 3, 23, 0),
    );
    expect(created.map((e) => toLocalInput(e.startsAt))).toEqual(["2026-10-20T17:00", "2026-10-27T17:00", "2026-11-03T17:00"]);
    expect(new Set(created.map((e) => e.seriesId)).size).toBe(1);
  });

  it("kan kun oprettes af holdets træner eller admin", async () => {
    const jonas = await ctxOf("jonas");
    await expect(
      createEventSeries(db, jonas, demo.teams.u9.id, { type: "training", title: "x", startsAt: new Date() }, new Date(Date.now() + 864e6)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("aflyser resten af serien, men ikke de tidligere", async () => {
    const mette = await ctxOf("mette");
    const created = await createEventSeries(
      db,
      mette,
      demo.teams.u9.id,
      { type: "training", title: "Vintertræning", startsAt: zonedTime(2027, 1, 5, 17, 0) },
      zonedTime(2027, 1, 26, 23, 0),
    );
    await setEventCancelled(db, mette, created[2].id, true, "following");
    const rows = await db.select().from(events).where(eq(events.seriesId, created[0].seriesId!));
    const cancelled = rows.filter((r) => r.cancelledAt).map((r) => toLocalInput(r.startsAt)).sort();
    expect(cancelled).toEqual(["2027-01-19T17:00", "2027-01-26T17:00"]);

    // Ingen kan melde til en aflyst træning.
    const niklas = await ctxOf("niklas");
    await expect(respondToEvent(db, niklas, created[3].id, demo.emma.id, "yes")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("svarfrist", () => {
  it("forælderen kan ikke ændre svar efter fristen, træneren kan", async () => {
    const deadline = demo.events.u9Match.responseDeadline!;
    const afterDeadline = new Date(deadline.getTime() + 60_000);
    const sofie = await ctxOf("sofie", afterDeadline);
    await expect(respondToEvent(db, sofie, demo.events.u9Match.id, demo.kids.ida.id, "no")).rejects.toBeInstanceOf(ForbiddenError);
    const mette = await ctxOf("mette", afterDeadline);
    await respondToEvent(db, mette, demo.events.u9Match.id, demo.kids.ida.id, "no", "Ringede til træneren");
  });

  it("svar på tidligere aktiviteter er lukket for forældre", async () => {
    const sofie = await ctxOf("sofie");
    await expect(respondToEvent(db, sofie, demo.events.u9PastMatch.id, demo.kids.ida.id, "yes")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("aktivitetens side", () => {
  it("viser alle svar, men kun kommentarer til træneren og egne børn", async () => {
    const sofie = await ctxOf("sofie");
    await respondToEvent(db, sofie, demo.events.u9Training.id, demo.kids.ida.id, "no", "Syg");
    // Ali er kun forælder (til Noor), ikke admin.
    const ali = await ctxOf("ali");
    await respondToEvent(db, ali, demo.events.u9Training.id, demo.kids.noor.id, "yes", "Kommer lidt senere");

    const asAli = await getEventDetail(db, ali, demo.events.u9Training.id);
    const ida = asAli.players.find((p) => p.profileId === demo.kids.ida.id)!;
    const noor = asAli.players.find((p) => p.profileId === demo.kids.noor.id)!;
    expect(ida.status).toBe("no");
    expect(ida.comment).toBeNull();
    expect(ida.respondedBy).toBeNull();
    expect(noor.comment).toBe("Kommer lidt senere");
    expect(noor.canRespond).toBe(true);
    expect(ida.canRespond).toBe(false);
    expect(asAli.canManage).toBe(false);

    const mette = await ctxOf("mette");
    const asCoach = await getEventDetail(db, mette, demo.events.u9Training.id);
    const idaForCoach = asCoach.players.find((p) => p.profileId === demo.kids.ida.id)!;
    expect(idaForCoach.comment).toBe("Syg");
    expect(idaForCoach.respondedBy).toBe("Sofie");
    expect(asCoach.canManage).toBe(true);
    expect(asCoach.players.every((p) => p.canRespond)).toBe(true);
  });

  it("er lukket for folk uden for holdet", async () => {
    const peter = await ctxOf("peter");
    await expect(getEventDetail(db, peter, demo.events.u9Training.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("trænerens overblik", () => {
  it("viser fremmøde pr. spiller for de seneste uger", async () => {
    const mette = await ctxOf("mette");
    const now = new Date();
    const overview = await getAttendanceOverview(db, mette, demo.teams.u9.id, new Date(now.getTime() - 28 * 864e5), new Date(now.getTime() + 14 * 864e5));
    expect(overview.players.map((p) => p.firstName)).toEqual(["Alma", "Emma", "Freja", "Ida", "Noor"]);
    expect(overview.events.some((e) => e.past)).toBe(true);
    for (const p of overview.players) {
      expect(p.cells).toHaveLength(overview.events.length);
      expect(p.rate).not.toBeNull();
      expect(p.rate!).toBeGreaterThanOrEqual(0);
      expect(p.rate!).toBeLessThanOrEqual(100);
    }
  });

  it("kun trænere og admins ser overblikket", async () => {
    const parentOnly = await ctxOf("sofie");
    await expect(
      getAttendanceOverview(db, parentOnly, demo.teams.u9.id, new Date(0), new Date()),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("holdets kalender tæller svar pr. aktivitet", async () => {
    const mette = await ctxOf("mette");
    const list = await listTeamEvents(db, mette, demo.teams.u9.id, new Date());
    const match = list.find((e) => e.id === demo.events.u9Match.id)!;
    expect(match.yes + match.no + match.maybe).toBeLessThanOrEqual(5);
  });
});

describe("hold og invitationslink", () => {
  it("en ny forælder opretter sit barn og melder det på holdet via linket", async () => {
    const parent = await registerUser(db, "ny.forælder@test.dk", { firstName: "Maja", lastName: "Friis" });
    let ctx = await loadAccessContext(db, parent.user.id);
    const kid = await createChildProfile(db, ctx, { firstName: "Liv", lastName: "Friis", birthDate: "2018-04-04" });
    ctx = await loadAccessContext(db, parent.user.id);

    const mette = await ctxOf("mette");
    const team = await getTeam(db, mette, demo.teams.u9.id);
    expect(team.inviteCode).toBeTruthy();
    expect((await findTeamByInvite(db, team.inviteCode!))?.name).toBe("U9 piger");

    await joinTeamByInvite(db, ctx, team.inviteCode!, kid.id);
    const teams = await listMyTeams(db, ctx);
    expect(teams.map((t) => [t.name, t.labels])).toEqual([["U9 piger", ["Liv er spiller"]]]);
    const family = await listFamily(db, ctx);
    expect(family[0].teams.map((t) => t.name)).toEqual(["U9 piger"]);
  });

  it("man kan ikke melde andres børn på et hold", async () => {
    const jonas = await ctxOf("jonas");
    const mette = await ctxOf("mette");
    const team = await getTeam(db, mette, demo.teams.u9.id);
    await expect(joinTeamByInvite(db, jonas, team.inviteCode!, demo.emma.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("et nulstillet link virker ikke længere", async () => {
    const mette = await ctxOf("mette");
    const old = (await getTeam(db, mette, demo.teams.u9.id)).inviteCode!;
    const fresh = await rotateInviteCode(db, mette, demo.teams.u9.id);
    expect(fresh).not.toBe(old);
    expect(await findTeamByInvite(db, old)).toBeNull();
  });

  it("forældre ser holdet, men ikke invitationslinket eller andres forældre", async () => {
    const niklas = await ctxOf("niklas");
    // Niklas er admin, så brug Sofie som almindelig forælder.
    const sofie = await ctxOf("sofie");
    const team = await getTeam(db, sofie, demo.teams.u9.id);
    expect(team.inviteCode).toBeNull();
    expect(team.players.every((p) => p.guardians.length === 0)).toBe(true);
    expect(team.players.find((p) => p.profileId === demo.kids.ida.id)?.mine).toBe(true);
    expect((await getTeam(db, niklas, demo.teams.u9.id)).inviteCode).not.toBeNull();
  });

  it("Niklas ser både sit eget hold, Emmas hold og foreningens andre hold", async () => {
    const teams = await listMyTeams(db, await ctxOf("niklas"));
    expect(teams.map((t) => [t.name, t.labels])).toEqual([
      ["Senior herrer", ["Spiller"]],
      ["U11 drenge", ["Admin"]],
      ["U9 piger", ["Emma er spiller"]],
    ]);
  });
});

describe("familie og trænere via e-mail", () => {
  it("tilføjer den anden forælder via e-mail", async () => {
    const other = await registerUser(db, "mor.bentsen@test.dk", { firstName: "Line", lastName: "Bentsen" });
    await addGuardianByEmail(db, await ctxOf("niklas"), demo.emma.id, "Mor.Bentsen@test.dk");
    const line = await loadAccessContext(db, other.user.id);
    expect(line.wards.has(demo.emma.id)).toBe(true);
    const family = await listFamily(db, await ctxOf("niklas"));
    expect(family.find((k) => k.id === demo.emma.id)?.otherGuardians).toEqual(["Line Bentsen"]);
  });

  it("admin gør en person til træner via e-mail, trænere kan ikke", async () => {
    const coach = await registerUser(db, "ny.traener@test.dk", { firstName: "Bo", lastName: "Riis" });
    await expect(addCoachByEmail(db, await ctxOf("mette"), demo.teams.u9.id, "ny.traener@test.dk")).rejects.toBeInstanceOf(ForbiddenError);
    await addCoachByEmail(db, await ctxOf("karen"), demo.teams.u9.id, "ny.traener@test.dk");
    const ctx = await loadAccessContext(db, coach.user.id);
    expect(ctx.coachTeams.has(demo.teams.u9.id)).toBe(true);
  });
});
