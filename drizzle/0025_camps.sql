CREATE TYPE "public"."camp_signup_status" AS ENUM('confirmed', 'waitlist', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."charge_kind" ADD VALUE 'camp';--> statement-breakpoint
CREATE TABLE "camp_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"signed_up_by_user_id" uuid,
	"status" "camp_signup_status" NOT NULL,
	"charge_id" uuid,
	"discount_percent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "camps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"price_ore" integer NOT NULL,
	"sibling_discount_percent" integer DEFAULT 0 NOT NULL,
	"capacity" integer,
	"signup_deadline" date,
	"cancelled_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "camp_signups" ADD CONSTRAINT "camp_signups_camp_id_camps_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "camp_signups" ADD CONSTRAINT "camp_signups_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "camp_signups" ADD CONSTRAINT "camp_signups_signed_up_by_user_id_users_id_fk" FOREIGN KEY ("signed_up_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "camp_signups" ADD CONSTRAINT "camp_signups_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "camps" ADD CONSTRAINT "camps_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "camps" ADD CONSTRAINT "camps_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "camp_signups_active_unique" ON "camp_signups" USING btree ("camp_id","profile_id") WHERE "camp_signups"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "camp_signups_camp_idx" ON "camp_signups" USING btree ("camp_id","status","created_at");--> statement-breakpoint
CREATE INDEX "camps_club_idx" ON "camps" USING btree ("club_id","starts_on");