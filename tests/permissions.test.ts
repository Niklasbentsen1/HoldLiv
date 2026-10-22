import { describe, expect, it } from "vitest";
import { can, isMinor, type AccessContext, type ProfileFacts } from "../src/auth/permissions";

const CLUB = "club-1";
const OTHER_CLUB = "club-2";
const U9 = { teamId: "u9", clubId: CLUB };
const SENIOR = { teamId: "senior", clubId: CLUB };
const FOREIGN = { teamId: "foreign", clubId: OTHER_CLUB };

const ctx = (over: Partial<AccessContext> = {}): AccessContext => ({
  userId: "u",
  profileId: "me",
  adminClubs: new Set(),
  coachTeams: new Set(),
  wards: new Set(),
  now: new Date("2026-10-22T12:00:00Z"),
  ...over,
});

const child: ProfileFacts = { profileId: "child", clubIds: [CLUB], teamIds: ["u9"] };
const stranger: ProfileFacts = { profileId: "stranger", clubIds: [CLUB], teamIds: ["u9"] };

describe("foreningsadmin", () => {
  const admin = ctx({ adminClubs: new Set([CLUB]) });

  it("styrer alt i egen forening", () => {
    expect(can(admin, { action: "club.manage", clubId: CLUB })).toBe(true);
    expect(can(admin, { action: "team.create", clubId: CLUB })).toBe(true);
    expect(can(admin, { action: "team.coaches.manage", team: U9 })).toBe(true);
    expect(can(admin, { action: "event.manage", event: SENIOR })).toBe(true);
    expect(can(admin, { action: "profile.edit", profile: stranger })).toBe(true);
    expect(can(admin, { action: "event.respond", event: U9, profile: stranger })).toBe(true);
  });

  it("har ingen adgang til andre foreninger", () => {
    expect(can(admin, { action: "club.manage", clubId: OTHER_CLUB })).toBe(false);
    expect(can(admin, { action: "team.manage", team: FOREIGN })).toBe(false);
    const foreignPlayer = { profileId: "x", clubIds: [OTHER_CLUB], teamIds: ["foreign"] };
    expect(can(admin, { action: "profile.view", profile: foreignPlayer })).toBe(false);
  });

  it("kan ikke agere som andres børn", () => {
    expect(can(admin, { action: "profile.actAs", profileId: "stranger" })).toBe(false);
  });
});

describe("træner", () => {
  const coach = ctx({ coachTeams: new Set(["u9"]) });

  it("administrerer eget hold og dets spillere", () => {
    expect(can(coach, { action: "team.manage", team: U9 })).toBe(true);
    expect(can(coach, { action: "team.players.manage", team: U9 })).toBe(true);
    expect(can(coach, { action: "event.manage", event: U9 })).toBe(true);
    expect(can(coach, { action: "event.respond", event: U9, profile: stranger })).toBe(true);
    expect(can(coach, { action: "profile.view", profile: stranger })).toBe(true);
  });

  it("må ikke udpege trænere, oprette hold eller styre andre hold", () => {
    expect(can(coach, { action: "team.coaches.manage", team: U9 })).toBe(false);
    expect(can(coach, { action: "team.create", clubId: CLUB })).toBe(false);
    expect(can(coach, { action: "team.manage", team: SENIOR })).toBe(false);
    expect(can(coach, { action: "event.manage", event: SENIOR })).toBe(false);
  });

  it("retter ikke spillernes personoplysninger", () => {
    expect(can(coach, { action: "profile.edit", profile: stranger })).toBe(false);
  });
});

describe("spiller", () => {
  const me: ProfileFacts = { profileId: "me", clubIds: [CLUB], teamIds: ["senior"] };
  const player = ctx();

  it("styrer egen profil og svarer på eget holds aktiviteter", () => {
    expect(can(player, { action: "profile.edit", profile: me })).toBe(true);
    expect(can(player, { action: "event.respond", event: SENIOR, profile: me })).toBe(true);
    expect(can(player, { action: "team.view", team: SENIOR, memberProfileIds: ["me"] })).toBe(true);
  });

  it("kan ikke svare for andre eller på andre holds aktiviteter", () => {
    expect(can(player, { action: "event.respond", event: U9, profile: stranger })).toBe(false);
    expect(can(player, { action: "event.respond", event: U9, profile: me })).toBe(false);
    expect(can(player, { action: "event.manage", event: SENIOR })).toBe(false);
    expect(can(player, { action: "profile.view", profile: stranger })).toBe(false);
  });
});

describe("forælder", () => {
  const parent = ctx({ wards: new Set(["child"]) });

  it("agerer som barnet: profil, tilmelding og holdets side", () => {
    expect(can(parent, { action: "profile.actAs", profileId: "child" })).toBe(true);
    expect(can(parent, { action: "profile.edit", profile: child })).toBe(true);
    expect(can(parent, { action: "profile.guardians.manage", profile: child })).toBe(true);
    expect(can(parent, { action: "event.respond", event: U9, profile: child })).toBe(true);
    expect(can(parent, { action: "team.view", team: U9, memberProfileIds: ["child", "stranger"] })).toBe(true);
    expect(can(parent, { action: "club.view", clubId: CLUB, memberProfileIds: ["child"] })).toBe(true);
  });

  it("får ikke trænerrettigheder af at agere som barnet", () => {
    expect(can(parent, { action: "event.manage", event: U9 })).toBe(false);
    expect(can(parent, { action: "event.respond", event: U9, profile: stranger })).toBe(false);
    expect(can(parent, { action: "profile.view", profile: stranger })).toBe(false);
  });
});

describe("svarfrist og aflysning", () => {
  const parent = ctx({ wards: new Set(["child"]) });
  const coach = ctx({ coachTeams: new Set(["u9"]) });
  const closed = { ...U9, responseDeadline: new Date("2026-10-22T10:00:00Z") };
  const open = { ...U9, responseDeadline: new Date("2026-10-22T14:00:00Z") };

  it("forælderen kan svare før fristen, men ikke efter", () => {
    expect(can(parent, { action: "event.respond", event: open, profile: child })).toBe(true);
    expect(can(parent, { action: "event.respond", event: closed, profile: child })).toBe(false);
  });

  it("uden frist lukker svarene, når aktiviteten starter", () => {
    const started = { ...U9, startsAt: new Date("2026-10-22T11:00:00Z") };
    const later = { ...U9, startsAt: new Date("2026-10-23T11:00:00Z") };
    expect(can(parent, { action: "event.respond", event: started, profile: child })).toBe(false);
    expect(can(parent, { action: "event.respond", event: later, profile: child })).toBe(true);
  });

  it("træneren kan registrere fremmøde efter fristen", () => {
    expect(can(coach, { action: "event.respond", event: closed, profile: child })).toBe(true);
  });

  it("ingen kan svare på en aflyst aktivitet", () => {
    const cancelled = { ...U9, cancelled: true };
    expect(can(parent, { action: "event.respond", event: cancelled, profile: child })).toBe(false);
    expect(can(coach, { action: "event.respond", event: cancelled, profile: child })).toBe(false);
  });
});

describe("flere roller på én profil", () => {
  // Niklas' eksempel: spiller på senior, far til en U9-spiller og i bestyrelsen.
  const niklas = ctx({ adminClubs: new Set([CLUB]), wards: new Set(["child"]) });
  const me: ProfileFacts = { profileId: "me", clubIds: [CLUB], teamIds: ["senior"] };

  it("summerer rettighederne fra alle roller", () => {
    expect(can(niklas, { action: "event.respond", event: SENIOR, profile: me })).toBe(true);
    expect(can(niklas, { action: "event.respond", event: U9, profile: child })).toBe(true);
    expect(can(niklas, { action: "club.manage", clubId: CLUB })).toBe(true);
    expect(can(niklas, { action: "team.coaches.manage", team: U9 })).toBe(true);
  });
});

describe("myndighedsalder", () => {
  const today = new Date("2026-10-22T12:00:00Z");
  it("værgerettigheder ophører på 18-års-dagen", () => {
    expect(isMinor("2016-05-01", today)).toBe(true);
    expect(isMinor("2008-10-23", today)).toBe(true);
    expect(isMinor("2008-10-22", today)).toBe(false);
    expect(isMinor("1990-01-01", today)).toBe(false);
  });
});
