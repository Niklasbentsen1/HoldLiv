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
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  index,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// admin = fuld adgang. treasurer = kasserer: medlemmer, kontingent og betalinger, intet andet.
export const clubRole = pgEnum("club_role", ["admin", "treasurer"]);
export const teamRole = pgEnum("team_role", ["coach", "player"]);
export const membershipStatus = pgEnum("membership_status", ["active", "inactive", "waitlist"]);
export const guardianRelation = pgEnum("guardian_relation", ["parent", "guardian"]);
export const eventType = pgEnum("event_type", ["training", "match", "tournament", "social", "other"]);
export const responseStatus = pgEnum("response_status", ["yes", "no", "maybe"]);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  // To-faktor (TOTP). Hemmeligheden gemmes krypteret, når TOTP_ENC_KEY er sat. pending = opsat, men endnu ikke bekræftet.
  totpSecret: text("totp_secret"),
  totpPendingSecret: text("totp_pending_secret"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  totpLastStep: integer("totp_last_step"),
  // Loft over forkerte koder pr. konto, uanset hvilken session der gætter.
  totpFailures: integer("totp_failures").notNull().default(0),
  totpLockedUntil: timestamp("totp_locked_until", { withTimezone: true }),
  createdAt: createdAt(),
});

// Engangskoder til at komme ind, hvis man har mistet sin autentificeringsapp. Kun hashes gemmes.
export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);

// Revisionslog: hvem gjorde hvad, og hvornår. Rækker slettes aldrig af appen.
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    at: createdAt(),
    clubId: uuid("club_id").references(() => clubs.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    detail: jsonb("detail"),
  },
  (t) => [index("audit_log_club_idx").on(t.clubId, t.at), index("audit_log_actor_idx").on(t.actorUserId, t.at)],
);

// Login med engangskode/link på e-mail. Kun hashes gemmes, aldrig selve koden.
export const loginTokens = pgTable(
  "login_tokens",
  {
    id: id(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    linkHash: text("link_hash").notNull().unique(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("login_tokens_email_idx").on(t.email, t.createdAt)],
);

// Aktive sessioner. id er sha256 af cookie-værdien, så et læk af databasen ikke giver adgang.
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Sat, når kontoen har to-faktor og koden endnu ikke er tastet. Sessionen giver ingen adgang, før den er fri.
    mfaPending: boolean("mfa_pending").notNull().default(false),
    mfaAttempts: integer("mfa_attempts").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

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
  // Foreningens egen Stripe-konto (Connect). Pengene går direkte til foreningen.
  stripeAccountId: text("stripe_account_id"),
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
    // Kontingentet medlemmet betaler. Null = ikke tildelt endnu.
    feeId: uuid("fee_id").references(() => membershipFees.id, { onDelete: "set null" }),
    // Gratist: trænere, frivillige, pause. Får ingen opkrævninger.
    exempt: boolean("exempt").notNull().default(false),
    joinedAt: createdAt(),
    leftAt: timestamp("left_at", { withTimezone: true }),
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
    // Kode til holdets invitationslink (/join/<kode>). Kan nulstilles af træner/admin.
    inviteCode: text("invite_code").notNull().unique(),
    // Kontingent nye spillere får, når de kommer på holdet og ikke har et i forvejen.
    defaultFeeId: uuid("default_fee_id").references(() => membershipFees.id, { onDelete: "set null" }),
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
    description: text("description"),
    location: text("location"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    responseDeadline: timestamp("response_deadline", { withTimezone: true }),
    // Antal pladser. De første "kommer"-svar (efter yes_since) får plads, resten står på venteliste.
    maxParticipants: integer("max_participants"),
    // Faste træninger oprettes som en serie af enkelte aktiviteter med samme series_id.
    seriesId: uuid("series_id"),
    // Aflyste aktiviteter bliver stående, så alle kan se at de er aflyst.
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("events_team_starts_idx").on(t.teamId, t.startsAt), index("events_series_idx").on(t.seriesId)],
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
    // Hvornår svaret blev "kommer". Bevares, når man blot ændrer beskeden, så man ikke mister sin plads i køen.
    yesSince: timestamp("yes_since", { withTimezone: true }),
    respondedByUserId: uuid("responded_by_user_id")
      .notNull()
      .references(() => users.id),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.profileId] })],
);

// --- Kontingent og betaling ---
// Beløb er i øre, så der aldrig regnes med kommatal.

export const feeInterval = pgEnum("fee_interval", ["month", "quarter", "half_year", "year"]);
export const chargeStatus = pgEnum("charge_status", ["open", "paid", "cancelled", "refunded"]);
export const paymentProvider = pgEnum("payment_provider", ["stripe", "mock", "manual"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "succeeded", "failed", "refunded"]);

// Kontingentsatser, fx "Børn under 13, 650 kr. pr. halvår".
export const membershipFees = pgTable(
  "membership_fees",
  {
    id: id(),
    clubId: uuid("club_id")
      .notNull()
      .references(() => clubs.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    amountOre: integer("amount_ore").notNull(),
    interval: feeInterval("interval").notNull(),
    // Arkiverede satser kan ikke vælges til nye medlemmer, men gamle opkrævninger bevares.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("membership_fees_club_idx").on(t.clubId)],
);

// Én opkrævning = ét medlem, én periode. Unik pr. medlem, sats og periode,
// så en opkrævningskørsel kan køres igen uden dobbelte opkrævninger.
export const charges = pgTable(
  "charges",
  {
    id: id(),
    clubId: uuid("club_id")
      .notNull()
      .references(() => clubs.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    feeId: uuid("fee_id").references(() => membershipFees.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    amountOre: integer("amount_ore").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    dueDate: date("due_date").notNull(),
    status: chargeStatus("status").notNull().default("open"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    reminderCount: integer("reminder_count").notNull().default(0),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("charges_member_period_unique").on(t.profileId, t.feeId, t.periodStart),
    index("charges_club_status_idx").on(t.clubId, t.status),
  ],
);

// Betalingsforsøg og betalinger. Et kortforsøg der afbrydes, bliver stående som pending.
export const payments = pgTable(
  "payments",
  {
    id: id(),
    chargeId: uuid("charge_id")
      .notNull()
      .references(() => charges.id, { onDelete: "cascade" }),
    provider: paymentProvider("provider").notNull(),
    // Stripe: Checkout Session id. Manuel: tom.
    providerRef: text("provider_ref").unique(),
    // Stripe: PaymentIntent id, som bruges til refundering.
    providerPaymentId: text("provider_payment_id"),
    amountOre: integer("amount_ore").notNull(),
    status: paymentStatus("status").notNull().default("pending"),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
  },
  (t) => [index("payments_charge_idx").on(t.chargeId)],
);

// --- Moduler pr. hold ---

// Hvilke moduler et hold bruger. En række pr. hold og modul; enabled=false beholder
// indstillingerne, hvis modulet slås til igen. Modulernes egne data ligger i egne tabeller.
export const teamModules = pgTable(
  "team_modules",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    module: text("module").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config").$type<Record<string, number | boolean>>().notNull().default({}),
    updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.module] })],
);

// --- Samkørsel (modul "carpool") ---

// En fører tilbyder pladser til én aktivitet. seats er pladser til andre end føreren selv.
export const carpoolOffers = pgTable(
  "carpool_offers",
  {
    id: id(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    driverProfileId: uuid("driver_profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    seats: integer("seats").notNull(),
    meetingPoint: text("meeting_point").notNull(),
    departsAt: timestamp("departs_at", { withTimezone: true }),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("carpool_offers_event_driver_unique").on(t.eventId, t.driverProfileId)],
);

// Passagerer. Unik pr. aktivitet, så en spiller kun sidder i én bil.
export const carpoolPassengers = pgTable(
  "carpool_passengers",
  {
    offerId: uuid("offer_id")
      .notNull()
      .references(() => carpoolOffers.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    addedByUserId: uuid("added_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.offerId, t.profileId] }), uniqueIndex("carpool_passengers_event_profile_unique").on(t.eventId, t.profileId)],
);

// "Vi mangler en lift." Forsvinder, når spilleren får en plads.
export const carpoolRequests = pgTable(
  "carpool_requests",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    note: text("note"),
    requestedByUserId: uuid("requested_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.profileId] })],
);

// --- Frugt og opgaver (modul "tasks") ---

export const taskKind = pgEnum("task_kind", ["fruit", "task"]);

// En opgave på holdet: frugt til en kamp, kridtning, oprydning. Opgaven hører til en familie, og familien er
// en spiller på holdet (spilleren og dennes værger). Uden assignee_profile_id mangler opgaven en familie.
export const teamTasks = pgTable(
  "team_tasks",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    kind: taskKind("kind").notNull(),
    title: text("title").notNull(),
    note: text("note"),
    // Hører opgaven til en aktivitet, fx frugt til kampen lørdag, følger den aktivitetens tidspunkt.
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    assigneeProfileId: uuid("assignee_profile_id").references(() => profiles.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    doneByUserId: uuid("done_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("team_tasks_team_idx").on(t.teamId, t.kind),
    index("team_tasks_event_idx").on(t.eventId),
    // Højst én frugtopgave pr. aktivitet, også når to trykker samtidig.
    uniqueIndex("team_tasks_one_fruit_per_event").on(t.eventId).where(sql`${t.kind} = 'fruit'`),
  ],
);

// --- Bødekasse (modul "fines") ---

// Holdets bødesatser, fx "For sent til træning, 10 kr." Beløbet bestemmer holdet selv; HoldLiv har ingen standardsatser.
export const fineTypes = pgTable(
  "fine_types",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    amountOre: integer("amount_ore").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("fine_types_team_idx").on(t.teamId)],
);

// En bøde til en spiller. Beskrivelse og beløb kopieres fra satsen, så en senere ændring af satsen ikke ændrer gamle bøder.
export const fines = pgTable(
  "fines",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    fineTypeId: uuid("fine_type_id").references(() => fineTypes.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    amountOre: integer("amount_ore").notNull(),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    givenByUserId: uuid("given_by_user_id").references(() => users.id, { onDelete: "set null" }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // Sat, når en betalt bøde trækkes tilbage: pengene er givet tilbage og tæller ikke længere som betalt.
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    // Trukne bøder tæller ikke med, men bliver stående som historik.
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("fines_team_profile_idx").on(t.teamId, t.profileId)],
);

// --- Beskeder: mail, SMS og (senere) push ---

// Hvilke beskeder et login vil have på hvilken kanal. Uden række gælder standarden i src/lib/notify.ts.
export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    channel: text("channel").notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.channel] })],
);

// Alt hvad der er sendt (eller forsøgt sendt) til et login. Giver overblik, og dedupe_key sørger for, at den samme
// besked ikke sendes to gange til samme login på samme kanal.
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    channel: text("channel").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    dedupeKey: text("dedupe_key"),
    // sent, failed (udbyderen fejlede) eller skipped (kanalen er ikke sat op eller mangler modtager)
    status: text("status").notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("notifications_dedupe_unique").on(t.userId, t.channel, t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
  ],
);

// Browsere, der har sagt ja til push-beskeder. Et login kan have flere (telefon, computer).
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Abonnementet følger den session, det blev oprettet i: logger man ud (eller udløber sessionen), holder push op.
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);

// Hemmeligt link til telefonens kalender. Den, der kender linket, kan se aktiviteterne, så det kan nulstilles.
export const calendarFeeds = pgTable("calendar_feeds", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  createdAt: createdAt(),
});

// --- Holdchat ---
// Grupperne (hele holdet, trænere, trænere + forældre) er automatiske: hvem der er med, regnes ud fra holdets
// trænere, spillere og forældre hver gang, så ingen skal tilføjes eller fjernes. Aktiviteter har deres egen chat.

export const chatKind = pgEnum("chat_kind", ["all", "coaches", "coaches_parents", "event"]);

export const chatThreads = pgTable(
  "chat_threads",
  {
    id: id(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    kind: chatKind("kind").notNull(),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("chat_threads_team_kind_unique").on(t.teamId, t.kind).where(sql`${t.kind} <> 'event'`),
    uniqueIndex("chat_threads_event_unique").on(t.eventId).where(sql`${t.eventId} is not null`),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: id(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authorProfileId: uuid("author_profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
    // Slettede beskeder bliver stående som tomme pladser, så en samtale ikke pludselig giver mindre mening.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByUserId: uuid("deleted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("chat_messages_thread_idx").on(t.threadId, t.createdAt)],
);

export const chatReads = pgTable(
  "chat_reads",
  {
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.userId] })],
);

// --- Nyheder og opslagstavle ---
// Et opslag hører til hele foreningen (team_id er tom) eller til ét hold. Nyheder skrives af ledelsen
// (admin for foreningen, trænere for holdet); opslagstavlen er åben for alle, der hører til, og opslag udløber.

export const postKind = pgEnum("post_kind", ["news", "board"]);

export const posts = pgTable(
  "posts",
  {
    id: id(),
    clubId: uuid("club_id")
      .notNull()
      .references(() => clubs.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    kind: postKind("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    pinned: boolean("pinned").notNull().default(false),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authorProfileId: uuid("author_profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("posts_club_idx").on(t.clubId, t.createdAt), index("posts_team_idx").on(t.teamId, t.createdAt)],
);
