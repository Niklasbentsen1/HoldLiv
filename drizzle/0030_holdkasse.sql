CREATE TYPE "public"."fund_entry_kind" AS ENUM('deposit', 'withdrawal');--> statement-breakpoint
CREATE TABLE "team_fund_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"kind" "fund_entry_kind" NOT NULL,
	"amount_ore" integer NOT NULL,
	"description" text NOT NULL,
	"profile_id" uuid,
	"entry_date" date NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "team_fund_entries" ADD CONSTRAINT "team_fund_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_fund_entries" ADD CONSTRAINT "team_fund_entries_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_fund_entries" ADD CONSTRAINT "team_fund_entries_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_fund_entries" ADD CONSTRAINT "team_fund_entries_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_fund_entries_team_idx" ON "team_fund_entries" USING btree ("team_id","entry_date");
--> statement-breakpoint
ALTER TABLE team_fund_entries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON team_fund_entries TO holdliv_app USING (team_id IN (SELECT id FROM teams)) WITH CHECK (team_id IN (SELECT id FROM teams));
