CREATE TYPE "public"."charge_status" AS ENUM('open', 'paid', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."fee_interval" AS ENUM('month', 'quarter', 'half_year', 'year');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('stripe', 'mock', 'manual');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'refunded');--> statement-breakpoint
ALTER TYPE "public"."club_role" ADD VALUE 'treasurer';--> statement-breakpoint
CREATE TABLE "charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"fee_id" uuid,
	"description" text NOT NULL,
	"amount_ore" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"due_date" date NOT NULL,
	"status" charge_status DEFAULT 'open' NOT NULL,
	"paid_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"reminder_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"amount_ore" integer NOT NULL,
	"interval" "fee_interval" NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"charge_id" uuid NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"provider_ref" text,
	"provider_payment_id" text,
	"amount_ore" integer NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	CONSTRAINT "payments_provider_ref_unique" UNIQUE("provider_ref")
);
--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "fee_id" uuid;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "left_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "stripe_account_id" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "default_fee_id" uuid;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_fee_id_membership_fees_id_fk" FOREIGN KEY ("fee_id") REFERENCES "public"."membership_fees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_fees" ADD CONSTRAINT "membership_fees_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_charge_id_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."charges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "charges_member_period_unique" ON "charges" USING btree ("profile_id","fee_id","period_start");--> statement-breakpoint
CREATE INDEX "charges_club_status_idx" ON "charges" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "membership_fees_club_idx" ON "membership_fees" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "payments_charge_idx" ON "payments" USING btree ("charge_id");--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_fee_id_membership_fees_id_fk" FOREIGN KEY ("fee_id") REFERENCES "public"."membership_fees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_default_fee_id_membership_fees_id_fk" FOREIGN KEY ("default_fee_id") REFERENCES "public"."membership_fees"("id") ON DELETE set null ON UPDATE no action;