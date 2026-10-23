ALTER TABLE "clubs" ADD COLUMN "site_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "site_intro" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "site_contact" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "site_show_teams" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "site_show_calendar" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "public_on_site" boolean DEFAULT false NOT NULL;