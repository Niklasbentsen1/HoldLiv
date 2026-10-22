CREATE TABLE "carpool_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"driver_profile_id" uuid NOT NULL,
	"seats" integer NOT NULL,
	"meeting_point" text NOT NULL,
	"departs_at" timestamp with time zone,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carpool_passengers" (
	"offer_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"added_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carpool_passengers_offer_id_profile_id_pk" PRIMARY KEY("offer_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "carpool_requests" (
	"event_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"note" text,
	"requested_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "carpool_requests_event_id_profile_id_pk" PRIMARY KEY("event_id","profile_id")
);
--> statement-breakpoint
ALTER TABLE "carpool_offers" ADD CONSTRAINT "carpool_offers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carpool_offers" ADD CONSTRAINT "carpool_offers_driver_profile_id_profiles_id_fk" FOREIGN KEY ("driver_profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carpool_offers" ADD CONSTRAINT "carpool_offers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carpool_passengers" ADD CONSTRAINT "carpool_passengers_offer_id_carpool_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."carpool_offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carpool_passengers" ADD CONSTRAINT "carpool_passengers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carpool_passengers" ADD CONSTRAINT "carpool_passengers_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carpool_passengers" ADD CONSTRAINT "carpool_passengers_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carpool_requests" ADD CONSTRAINT "carpool_requests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carpool_requests" ADD CONSTRAINT "carpool_requests_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carpool_requests" ADD CONSTRAINT "carpool_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "carpool_offers_event_driver_unique" ON "carpool_offers" USING btree ("event_id","driver_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "carpool_passengers_event_profile_unique" ON "carpool_passengers" USING btree ("event_id","profile_id");