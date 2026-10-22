// Kapacitet og venteliste pr. hold, mod en rigtig Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
import { testDb } from "./db";
import { seedDemo } from "../src/db/demo";
import { loadAccessContext } from "../src/auth/context";
import { clubMemberships, teamMembers, teamWaitlist } from "../src/db/schema";
import {
  addTeamMember,
  createChildProfile,
  createTeam,
  getTeam,
  joinTeamByInvite,
  joinWaitlist,
  leaveWaitlist,
  listWaitlist,
  myWaitlistPositions,
  promoteFromWaitlist,
  registerUser,
  removePlayerNotifying,
  setTeamCapacity,
  teamSpots,
  type Deliver,
} from "../src/services";

const { db, sql, reset } = testDb();
let demo: Awaited<ReturnType<typeof seedDemo>>;
const mails: { to: string; subject: string }[] = [];
const deliver: Deliver = { baseUrl: "https://holdliv.test", mail: async (to, subject) => void mails.push({ to, subject }), sms: null };

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
let n = 0;

/** Et nyt hold med en træner (Mette), så hvert testtilfælde er sit eget. */
async function newTeam(capacity: number | null, autoPromote = false) {
  const karen = await ctxOf("karen");
  const team = await createTeam(db, karen, demo.club.id, `Hold ${++n}`, "2026/27");
  await addTeamMember(db, karen, team.id, demo.users.mette.profile.id, "coach");
  await setTeamCapacity(db, karen, team.id, capacity, autoPromote);
  return team;
}

/** En ny forælder med ét barn, klar til at tilmelde. */
async function family(tag: string) {
  const p = await registerUser(db, `${tag}${++n}@venter.test`, { firstName: "Far", lastName: tag, birthDate: "1985-01-01" });
  const ctx0 = await loadAccessContext(db, p.user.id);
  const child = await createChildProfile(db, ctx0, { firstName: tag, lastName: "Barn", birthDate: "2016-01-01" });
  return { p, child, ctx: await loadAccessContext(db, p.user.id) };
}

const players = async (teamId: string) => (await db.select().from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, "player")))).length;

describe("kapacitet", () => {
  it("tæller pladser og afviser ugyldige tal", async () => {
    const team = await newTeam(2);
    const karen = await ctxOf("karen");
    expect(await teamSpots(db, team.id)).toMatchObject({ capacity: 2, players: 0, free: 2, full: false });
    await expect(setTeamCapacity(db, karen, team.id, -1)).rejects.toThrow(/helt tal/);
    await expect(setTeamCapacity(db, karen, team.id, 1.5)).rejects.toThrow(/helt tal/);
    await setTeamCapacity(db, karen, team.id, null);
    expect(await teamSpots(db, team.id)).toMatchObject({ capacity: null, free: null, full: false });
    // Kun trænere og admin sætter antallet.
    await expect(setTeamCapacity(db, await ctxOf("sofie"), team.id, 5)).rejects.toThrow();
  });

  it("et fuldt hold sætter nye på ventelisten via invitationslinket, i rækkefølge", async () => {
    const team = await newTeam(1);
    const a = await family("A");
    const b = await family("B");
    const c = await family("C");
    expect((await joinTeamByInvite(db, a.ctx, team.inviteCode, a.child.id)).waitlisted).toBe(false);
    expect((await joinTeamByInvite(db, b.ctx, team.inviteCode, b.child.id)).waitlisted).toBe(true);
    expect((await joinTeamByInvite(db, c.ctx, team.inviteCode, c.child.id)).waitlisted).toBe(true);
    // Samme link igen ændrer ikke pladsen i køen.
    await joinTeamByInvite(db, b.ctx, team.inviteCode, b.child.id);
    expect(await players(team.id)).toBe(1);
    const mette = await ctxOf("mette");
    expect((await listWaitlist(db, mette, team.id)).map((w) => [w.firstName, w.position])).toEqual([["B", 1], ["C", 2]]);
    expect(await myWaitlistPositions(db, b.ctx)).toEqual([expect.objectContaining({ team: team.name, position: 1 })]);
    // Den på ventelisten er ikke medlem af foreningen endnu.
    expect(await db.select().from(clubMemberships).where(eq(clubMemberships.profileId, b.child.id))).toEqual([]);
  });

  it("to samtidige tilmeldinger tager ikke begge den sidste plads", async () => {
    const team = await newTeam(1);
    const a = await family("P");
    const b = await family("Q");
    const [ra, rb] = await Promise.all([joinTeamByInvite(db, a.ctx, team.inviteCode, a.child.id), joinTeamByInvite(db, b.ctx, team.inviteCode, b.child.id)]);
    expect([ra.waitlisted, rb.waitlisted].sort()).toEqual([false, true]);
    expect(await players(team.id)).toBe(1);
  });

  it("en træner kan ikke tilføje en spiller til et fuldt hold, men kan altid tilføje en træner", async () => {
    const team = await newTeam(0);
    const mette = await ctxOf("mette");
    const karen = await ctxOf("karen");
    const x = await family("X");
    await addTeamMember(db, karen, team.id, demo.users.peter.profile.id, "coach");
    await db.insert(clubMemberships).values({ clubId: demo.club.id, profileId: x.child.id }).onConflictDoNothing();
    await expect(addTeamMember(db, mette, team.id, x.child.id, "player")).rejects.toThrow(/fuldt/);
  });
});

describe("venteliste", () => {
  it("man kan selv stille sig i kø, og en anden kan ikke træde ud for én", async () => {
    const team = await newTeam(0);
    const a = await family("K");
    const other = await family("L");
    await joinWaitlist(db, a.ctx, team.id, a.child.id, "Gerne torsdag");
    await expect(joinWaitlist(db, other.ctx, team.id, a.child.id)).rejects.toThrow();
    await expect(leaveWaitlist(db, other.ctx, team.id, a.child.id)).rejects.toThrow();
    // Forælderen ser kun egne børn; træneren ser alle, med forældre og besked.
    expect((await listWaitlist(db, a.ctx, team.id)).map((w) => w.firstName)).toEqual(["K"]);
    expect((await listWaitlist(db, other.ctx, team.id))).toEqual([]);
    const lead = (await listWaitlist(db, await ctxOf("mette"), team.id))[0] as unknown as { note: string; guardians: unknown[] };
    expect(lead.note).toBe("Gerne torsdag");
    expect(lead.guardians).toHaveLength(1);
    await leaveWaitlist(db, a.ctx, team.id, a.child.id);
    expect(await db.select().from(teamWaitlist).where(eq(teamWaitlist.teamId, team.id))).toEqual([]);
  });

  it("træneren rykker op manuelt, kun når der er plads, og forældrene får besked", async () => {
    const team = await newTeam(1);
    const a = await family("M");
    const b = await family("N");
    await joinTeamByInvite(db, a.ctx, team.inviteCode, a.child.id);
    await joinTeamByInvite(db, b.ctx, team.inviteCode, b.child.id);
    const mette = await ctxOf("mette");
    await expect(promoteFromWaitlist(db, mette, team.id, b.child.id, { deliver })).rejects.toThrow(/fuldt/);
    await expect(promoteFromWaitlist(db, await ctxOf("sofie"), team.id, b.child.id)).rejects.toThrow();
    await setTeamCapacity(db, await ctxOf("karen"), team.id, 2);
    await promoteFromWaitlist(db, mette, team.id, b.child.id, { deliver });
    expect(await players(team.id)).toBe(2);
    expect(await db.select().from(teamWaitlist).where(eq(teamWaitlist.teamId, team.id))).toEqual([]);
    expect((await db.select().from(clubMemberships).where(eq(clubMemberships.profileId, b.child.id))).length).toBe(1);
    expect(mails.map((m) => m.to)).toEqual([b.p.user.email]);
    expect(mails[0].subject).toContain(team.name);
    await expect(promoteFromWaitlist(db, mette, team.id, b.child.id)).rejects.toThrow(/ikke på ventelisten/);
    // Bevidst overtrækning er muligt.
    const c = await family("O");
    await joinWaitlist(db, c.ctx, team.id, c.child.id);
    await expect(promoteFromWaitlist(db, mette, team.id, c.child.id)).rejects.toThrow(/fuldt/);
    await promoteFromWaitlist(db, mette, team.id, c.child.id, { allowOverfull: true });
    expect(await players(team.id)).toBe(3);
  });
});

describe("automatisk oprykning og besked til trænerne", () => {
  it("med automatik rykker den første op, når en spiller forlader holdet", async () => {
    const team = await newTeam(2, true);
    const [a, b, c, d] = [await family("R1"), await family("R2"), await family("R3"), await family("R4")];
    for (const f of [a, b, c, d]) await joinTeamByInvite(db, f.ctx, team.inviteCode, f.child.id);
    expect(await players(team.id)).toBe(2);
    const mette = await ctxOf("mette");
    await removePlayerNotifying(db, mette, deliver, team.id, a.child.id);
    const members = (await db.select().from(teamMembers).where(eq(teamMembers.teamId, team.id))).map((m) => m.profileId);
    expect(members).toContain(c.child.id); // første i køen
    expect(members).not.toContain(d.child.id);
    expect(mails.map((m) => m.to)).toEqual([c.p.user.email]);
    // Hæves antallet, rykker flere op med det samme.
    await setTeamCapacity(db, await ctxOf("karen"), team.id, 3, true, deliver);
    expect(await players(team.id)).toBe(3);
    expect(await db.select().from(teamWaitlist).where(eq(teamWaitlist.teamId, team.id))).toEqual([]);
  });

  it("uden automatik får trænerne besked om den ledige plads", async () => {
    const team = await newTeam(1, false);
    const a = await family("S1");
    const b = await family("S2");
    await joinTeamByInvite(db, a.ctx, team.inviteCode, a.child.id);
    await joinTeamByInvite(db, b.ctx, team.inviteCode, b.child.id);
    await removePlayerNotifying(db, await ctxOf("mette"), deliver, team.id, a.child.id);
    expect(await players(team.id)).toBe(0);
    expect(mails.map((m) => m.to)).toEqual([demo.users.mette.user.email]);
    expect(mails[0].subject).toMatch(/Ledig plads/);
    const view = await getTeam(db, await ctxOf("mette"), team.id);
    expect(view.spots).toMatchObject({ capacity: 1, players: 0, waiting: 1, free: 1 });
  });
});
