CREATE TYPE "public"."certificate_status" AS ENUM('needed', 'requested', 'approved', 'not_approved');--> statement-breakpoint
CREATE TYPE "public"."contract_kind" AS ENUM('coach', 'player', 'volunteer', 'other');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('draft', 'sent', 'signed', 'declined', 'cancelled');--> statement-breakpoint
CREATE TABLE "child_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"status" "certificate_status" DEFAULT 'needed' NOT NULL,
	"reason" text,
	"consent_at" timestamp with time zone,
	"consent_by_user_id" uuid,
	"consent_method" text,
	"requested_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"issued_on" date,
	"expires_on" date,
	"registered_by_user_id" uuid,
	"last_reminder_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"kind" "contract_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"monthly_amount_ore" integer,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"body_hash" text,
	"sent_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"expiry_notice_sent_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signed_by_user_id" uuid,
	"signed_name" text,
	"declined_reason" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shift_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"club_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"signed_up_by_user_id" uuid,
	"reminder_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "volunteer_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"team_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"slots" integer DEFAULT 1 NOT NULL,
	"requires_child_certificate" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "child_certificates" ADD CONSTRAINT "child_certificates_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_certificates" ADD CONSTRAINT "child_certificates_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_certificates" ADD CONSTRAINT "child_certificates_consent_by_user_id_users_id_fk" FOREIGN KEY ("consent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_certificates" ADD CONSTRAINT "child_certificates_registered_by_user_id_users_id_fk" FOREIGN KEY ("registered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_signed_by_user_id_users_id_fk" FOREIGN KEY ("signed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_signups" ADD CONSTRAINT "shift_signups_shift_id_volunteer_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."volunteer_shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_signups" ADD CONSTRAINT "shift_signups_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_signups" ADD CONSTRAINT "shift_signups_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_signups" ADD CONSTRAINT "shift_signups_signed_up_by_user_id_users_id_fk" FOREIGN KEY ("signed_up_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_shifts" ADD CONSTRAINT "volunteer_shifts_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_shifts" ADD CONSTRAINT "volunteer_shifts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_shifts" ADD CONSTRAINT "volunteer_shifts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "child_certificates_unique" ON "child_certificates" USING btree ("club_id","profile_id");--> statement-breakpoint
CREATE INDEX "child_certificates_club_idx" ON "child_certificates" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "contracts_club_idx" ON "contracts" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "contracts_profile_idx" ON "contracts" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shift_signups_unique" ON "shift_signups" USING btree ("shift_id","profile_id");--> statement-breakpoint
CREATE INDEX "shift_signups_profile_idx" ON "shift_signups" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "volunteer_shifts_club_idx" ON "volunteer_shifts" USING btree ("club_id","starts_at");
--> statement-breakpoint
ALTER TABLE volunteer_shifts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON volunteer_shifts TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
--> statement-breakpoint
ALTER TABLE shift_signups ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON shift_signups TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
--> statement-breakpoint
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON contracts TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
--> statement-breakpoint
ALTER TABLE child_certificates ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON child_certificates TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));