ALTER TYPE "public"."event_type" ADD VALUE 'tournament' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "public"."event_type" ADD VALUE 'social' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "calendar_feeds" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_feeds_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "calendar_feeds" ADD CONSTRAINT "calendar_feeds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;