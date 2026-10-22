CREATE TYPE "public"."task_kind" AS ENUM('fruit', 'task');--> statement-breakpoint
CREATE TABLE "team_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"kind" "task_kind" NOT NULL,
	"title" text NOT NULL,
	"note" text,
	"event_id" uuid,
	"assignee_profile_id" uuid,
	"assigned_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"done_by_user_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_assignee_profile_id_profiles_id_fk" FOREIGN KEY ("assignee_profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_done_by_user_id_users_id_fk" FOREIGN KEY ("done_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_tasks" ADD CONSTRAINT "team_tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_tasks_team_idx" ON "team_tasks" USING btree ("team_id","kind");--> statement-breakpoint
CREATE INDEX "team_tasks_event_idx" ON "team_tasks" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_tasks_one_fruit_per_event" ON "team_tasks" USING btree ("event_id") WHERE "team_tasks"."kind" = 'fruit';