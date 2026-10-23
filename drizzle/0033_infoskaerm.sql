CREATE TABLE "info_screens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token" text NOT NULL,
	"message" text,
	"show_news" boolean DEFAULT true NOT NULL,
	"days_ahead" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "info_screens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "info_screens" ADD CONSTRAINT "info_screens_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "info_screens_club_idx" ON "info_screens" USING btree ("club_id");
--> statement-breakpoint
ALTER TABLE info_screens ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON info_screens TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
