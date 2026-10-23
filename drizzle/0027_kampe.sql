CREATE TYPE "public"."lineup_slot" AS ENUM('start', 'bench');--> statement-breakpoint
CREATE TYPE "public"."match_event_kind" AS ENUM('goal', 'yellow', 'red');--> statement-breakpoint
CREATE TABLE "match_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" "match_event_kind" NOT NULL,
	"profile_id" uuid,
	"assist_profile_id" uuid,
	"minute" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"slot" "lineup_slot" NOT NULL,
	"position" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"minutes" integer
);
--> statement-breakpoint
CREATE TABLE "match_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"opponent" text,
	"formation" text,
	"lineup_published_at" timestamp with time zone,
	"goals_for" integer,
	"goals_against" integer,
	"played_at" timestamp with time zone,
	"report" text,
	"report_published_at" timestamp with time zone,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_assist_profile_id_profiles_id_fk" FOREIGN KEY ("assist_profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_sheets" ADD CONSTRAINT "match_sheets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_sheets" ADD CONSTRAINT "match_sheets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_sheets" ADD CONSTRAINT "match_sheets_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_events_event_idx" ON "match_events" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_players_unique" ON "match_players" USING btree ("event_id","profile_id");--> statement-breakpoint
CREATE INDEX "match_players_profile_idx" ON "match_players" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_sheets_event_unique" ON "match_sheets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "match_sheets_team_idx" ON "match_sheets" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE match_sheets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON match_sheets TO holdliv_app USING (team_id IN (SELECT id FROM teams)) WITH CHECK (team_id IN (SELECT id FROM teams));--> statement-breakpoint
ALTER TABLE match_players ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON match_players TO holdliv_app USING (event_id IN (SELECT id FROM events)) WITH CHECK (event_id IN (SELECT id FROM events));--> statement-breakpoint
ALTER TABLE match_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON match_events TO holdliv_app USING (event_id IN (SELECT id FROM events)) WITH CHECK (event_id IN (SELECT id FROM events));
