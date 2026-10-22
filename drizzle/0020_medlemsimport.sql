CREATE TABLE "member_field_values" (
	"field_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "member_field_values_field_id_profile_id_pk" PRIMARY KEY("field_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "member_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_field_values" ADD CONSTRAINT "member_field_values_field_id_member_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."member_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_field_values" ADD CONSTRAINT "member_field_values_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_fields" ADD CONSTRAINT "member_fields_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "member_field_values_profile_idx" ON "member_field_values" USING btree ("profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_fields_club_name_unique" ON "member_fields" USING btree ("club_id","name");