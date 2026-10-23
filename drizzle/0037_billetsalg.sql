CREATE TYPE "public"."ticket_order_status" AS ENUM('pending', 'paid', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"event_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"location" text,
	"starts_at" timestamp with time zone NOT NULL,
	"price_ore" integer NOT NULL,
	"capacity" integer,
	"sale_closes_at" timestamp with time zone,
	"max_per_order" integer DEFAULT 10 NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_event_id" uuid NOT NULL,
	"club_id" uuid NOT NULL,
	"buyer_name" text NOT NULL,
	"buyer_email" text NOT NULL,
	"quantity" integer NOT NULL,
	"amount_ore" integer NOT NULL,
	"status" "ticket_order_status" DEFAULT 'pending' NOT NULL,
	"provider" "payment_provider",
	"provider_ref" text,
	"provider_payment_id" text,
	"access_token" text NOT NULL,
	"ip_hash" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	CONSTRAINT "ticket_orders_provider_ref_unique" UNIQUE("provider_ref"),
	CONSTRAINT "ticket_orders_access_token_unique" UNIQUE("access_token")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"ticket_event_id" uuid NOT NULL,
	"club_id" uuid NOT NULL,
	"code" text NOT NULL,
	"voided_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"used_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_ticket_event_id_ticket_events_id_fk" FOREIGN KEY ("ticket_event_id") REFERENCES "public"."ticket_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_ticket_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ticket_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ticket_event_id_ticket_events_id_fk" FOREIGN KEY ("ticket_event_id") REFERENCES "public"."ticket_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_used_by_user_id_users_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_events_club_idx" ON "ticket_events" USING btree ("club_id","starts_at");--> statement-breakpoint
CREATE INDEX "ticket_orders_event_idx" ON "ticket_orders" USING btree ("ticket_event_id","status");--> statement-breakpoint
CREATE INDEX "ticket_orders_club_idx" ON "ticket_orders" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "tickets_order_idx" ON "tickets" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "tickets_event_idx" ON "tickets" USING btree ("ticket_event_id");--> statement-breakpoint
ALTER TABLE ticket_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON ticket_events TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));--> statement-breakpoint
ALTER TABLE ticket_orders ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON ticket_orders TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));--> statement-breakpoint
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON tickets TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
