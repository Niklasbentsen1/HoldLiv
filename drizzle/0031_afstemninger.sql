CREATE TABLE "poll_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" uuid NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"voted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"question" text NOT NULL,
	"description" text,
	"multiple" boolean DEFAULT false NOT NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"closes_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_option_id_poll_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_voted_by_user_id_users_id_fk" FOREIGN KEY ("voted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "poll_options_poll_idx" ON "poll_options" USING btree ("poll_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "poll_votes_unique" ON "poll_votes" USING btree ("option_id","profile_id");--> statement-breakpoint
CREATE INDEX "poll_votes_profile_idx" ON "poll_votes" USING btree ("poll_id","profile_id");--> statement-breakpoint
CREATE INDEX "polls_team_idx" ON "polls" USING btree ("team_id","created_at");
--> statement-breakpoint
ALTER TABLE polls ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON polls TO holdliv_app USING (team_id IN (SELECT id FROM teams)) WITH CHECK (team_id IN (SELECT id FROM teams));--> statement-breakpoint
ALTER TABLE poll_options ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON poll_options TO holdliv_app USING (poll_id IN (SELECT id FROM polls)) WITH CHECK (poll_id IN (SELECT id FROM polls));--> statement-breakpoint
ALTER TABLE poll_votes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON poll_votes TO holdliv_app USING (poll_id IN (SELECT id FROM polls)) WITH CHECK (poll_id IN (SELECT id FROM polls));
