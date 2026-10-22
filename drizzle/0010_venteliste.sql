ALTER TABLE "event_responses" ADD COLUMN "yes_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "max_participants" integer;--> statement-breakpoint
UPDATE "event_responses" SET "yes_since" = "responded_at" WHERE "status" = 'yes';
