// HoldLiv datamodel: personer, roller og tilmeldinger.
//
// Grundidé:
//   user     = et login (en person med telefon/e-mail).
//   profile  = en person i HoldLiv. Har en profil et login, er user_id sat.
//              Børneprofiler har intet login; de styres af værger (guardianships).
//   Roller er ikke et felt på profilen. De er rækker i club_roles og team_members,
//   så én profil kan være admin i foreningen, træner på ét hold og spiller på et andet.
import { sql } from "drizzle-orm";
import {
  date,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  index,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const clubRole = pgEnum("club_role", ["admin"]);
export const teamRole = pgEnum("team_role", ["coach", "player"]);
export const membershipStatus = pgEnum("membership_status", ["active", "inactive", "waitlist"]);
export const guardianRelation = pgEnum("guardian_relation", ["parent", "guardian"]);
export const eventType = pgEnum("event_type", ["training", "match", "other"]);
export const responseStatus = pgEnum("response_status", ["yes", "no", "maybe"]);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  createdAt: createdAt(),
});

export const profiles = pgTable(
  "profiles",
  {
    id: id(),
    // Højst én profil pr. login. Null = profil uden login (typisk et barn).
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    birthDate: date("birth_date"),
    email: text("email"),
    phone: text("phone"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("profiles_user_id_unique").on(t.userId)],
);

// Forælder/værge -> barn. Værgen er en profil, så den samme person
// kan være værge og samtidig selv spiller eller admin.
export const guardianships = pgTable(
  "guardianships",
  {
    guardianProfileId: uuid("guardian_profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    childProfileId: uuid("child_profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    relation: guardianRelation("relation").notNull().default("parent"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.guardianProfileId, t.childProfileId] }),
    index("guardianships_child_idx").on(t.childProfileId),
  ],
);

export const clubs = pgTable("clubs", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: createdAt(),
});

export const clubMemberships = pgTable(
  "club_memberships",
  {
    clubId: uuid("club_id")
      .notNull()
      .references(() => clubs.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    status: membershipStatus("status").notNull().default("active"),
    joinedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.clubId, t.profileId] }), index("club_memberships_profile_idx").on(t.profileId)],
);

// Foreningsroller. "admin" giver adgang til alt i foreningen.
// title er fri tekst til visning: "Formand", "Kasserer", "Bestyrelsesmedlem".
export const clubRoles = pgTable(
  "club_roles",
  {
    clubId: uuid("club_id")
      .notNull()
      .references(() => clubs.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    role: clubRole("role").notNull(),
    title: text("title"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.clubId, t.profileId, t.role] }), index("club_roles_profile_idx").on(t.profileId)],
);

export const teams = pgTable(
  "teams",
  {
    id: id(),
    clubId: uuid("club_id")
      .notNull()
      .references(() => clubs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    season: text("season"),
    createdAt: createdAt(),
  },
  (t) => [index("teams_club_idx").on(t.clubId)],
);

// Holdroller: træner eller spiller. Samme profil kan have begge på samme hold.
export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    role: teamRole("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.profileId, t.role] }), index("team_members_profile_idx").on(t.profileId)],
);

export const events = pgTable(
  "events",
  {
    id: id(),
    clubId: uuid("club_id")
      .notNull()
      .references(() => clubs.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    type: eventType("type").notNull(),
    title: text("title").notNull(),
    location: text("location"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    responseDeadline: timestamp("response_deadline", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("events_team_starts_idx").on(t.teamId, t.startsAt)],
);

// Til- og frameldinger. respondedByUserId er login'et der trykkede,
// så man kan se "Meldt fra af Niklas (far)" på barnets svar.
export const eventResponses = pgTable(
  "event_responses",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    status: responseStatus("status").notNull(),
    comment: text("comment"),
    respondedByUserId: uuid("responded_by_user_id")
      .notNull()
      .references(() => users.id),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.profileId] })],
);
