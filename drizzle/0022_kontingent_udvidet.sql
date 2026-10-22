CREATE TYPE "public"."charge_kind" AS ENUM('fee', 'join_fee', 'other');--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "kind" charge_kind DEFAULT 'fee' NOT NULL;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "discount_percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "arrears_block_days" integer;--> statement-breakpoint
ALTER TABLE "membership_fees" ADD COLUMN "join_fee_ore" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "membership_fees" ADD COLUMN "prorate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "membership_fees" ADD COLUMN "sibling_discount_percent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "charges_join_fee_unique" ON "charges" USING btree ("club_id","profile_id") WHERE "charges"."kind" = 'join_fee';--> statement-breakpoint
UPDATE "charges" SET "kind" = 'other' WHERE "fee_id" IS NULL;
