CREATE TYPE "public"."document_audience" AS ENUM('club', 'team', 'board');--> statement-breakpoint
CREATE TABLE "club_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"team_id" uuid,
	"audience" "document_audience" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"uploaded_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "club_documents" ADD CONSTRAINT "club_documents_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_documents" ADD CONSTRAINT "club_documents_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_documents" ADD CONSTRAINT "club_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_documents_club_idx" ON "club_documents" USING btree ("club_id","audience");--> statement-breakpoint
CREATE INDEX "club_documents_team_idx" ON "club_documents" USING btree ("team_id");
--> statement-breakpoint
ALTER TABLE club_documents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY club_isolation ON club_documents TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));