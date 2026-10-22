CREATE TABLE "team_waitlist" (
	"team_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_waitlist_team_id_profile_id_pk" PRIMARY KEY("team_id","profile_id")
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "capacity" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "auto_promote" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_waitlist" ADD CONSTRAINT "team_waitlist_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_waitlist" ADD CONSTRAINT "team_waitlist_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_waitlist" ADD CONSTRAINT "team_waitlist_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_waitlist_order_idx" ON "team_waitlist" USING btree ("team_id","created_at");