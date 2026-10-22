ALTER TABLE "users" ADD COLUMN "totp_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_locked_until" timestamp with time zone;