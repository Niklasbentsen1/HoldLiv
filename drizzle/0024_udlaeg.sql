CREATE TYPE "public"."expense_kind" AS ENUM('expense', 'mileage');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('submitted', 'approved', 'rejected', 'paid', 'cancelled');--> statement-breakpoint
CREATE TABLE "expense_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"team_id" uuid,
	"kind" "expense_kind" NOT NULL,
	"description" text NOT NULL,
	"amount_ore" integer NOT NULL,
	"km_tenths" integer,
	"rate_ore_per_km" integer,
	"spent_on" date NOT NULL,
	"status" "expense_status" DEFAULT 'submitted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" uuid,
	"reject_reason" text,
	"paid_at" timestamp with time zone,
	"paid_by_user_id" uuid,
	"pay_note" text
);
--> statement-breakpoint
CREATE TABLE "expense_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_receipts_claim_id_unique" UNIQUE("claim_id")
);
--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "mileage_rate_ore_per_km" integer;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_receipts" ADD CONSTRAINT "expense_receipts_claim_id_expense_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."expense_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_claims_club_status_idx" ON "expense_claims" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "expense_claims_profile_idx" ON "expense_claims" USING btree ("profile_id");