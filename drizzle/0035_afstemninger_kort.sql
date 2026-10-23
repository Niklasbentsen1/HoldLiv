CREATE TABLE "poll_voters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"poll_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "poll_votes" ALTER COLUMN "profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "card_invalid_when_overdue" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "poll_voters" ADD CONSTRAINT "poll_voters_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_voters" ADD CONSTRAINT "poll_voters_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "poll_voters_unique" ON "poll_voters" USING btree ("poll_id","profile_id");--> statement-breakpoint
-- Eksisterende stemmer: noter hvem der har stemt, og fjern koblingen til personen i anonyme afstemninger.
INSERT INTO poll_voters (poll_id, profile_id) SELECT DISTINCT poll_id, profile_id FROM poll_votes WHERE profile_id IS NOT NULL;--> statement-breakpoint
UPDATE poll_votes SET profile_id = NULL, voted_by_user_id = NULL WHERE poll_id IN (SELECT id FROM polls WHERE anonymous);--> statement-breakpoint
ALTER TABLE poll_voters ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON poll_voters TO holdliv_app USING (poll_id IN (SELECT id FROM polls)) WITH CHECK (poll_id IN (SELECT id FROM polls));
