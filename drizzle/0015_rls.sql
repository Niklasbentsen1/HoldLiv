-- Row-level security pr. forening. Appen forbinder som en rolle uden ejerrettigheder (holdliv_app) og sætter
-- app.user_id for hver forespørgsel (se src/db/scope.ts). Så kan en forespørgsel kun se rækker i de foreninger,
-- personen (eller et barn personen er værge for) er medlem af. Uden app.user_id ses ingenting.
-- Ejeren (migrationer, cron, webhooks) omgår RLS og er "systemet".
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'holdliv_app') THEN CREATE ROLE holdliv_app NOLOGIN; END IF;
END $$;
--> statement-breakpoint
-- Appens databasebruger skal være medlem af rollen for at kunne SET ROLE (ved hosting: GRANT holdliv_app TO <app-bruger>).
GRANT holdliv_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO holdliv_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO holdliv_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO holdliv_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM holdliv_app;
--> statement-breakpoint
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION app_visible_clubs() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH me AS (
    SELECT p.id FROM profiles p WHERE p.user_id = app_user_id()
    UNION
    SELECT g.child_profile_id FROM guardianships g JOIN profiles gp ON gp.id = g.guardian_profile_id WHERE gp.user_id = app_user_id()
  )
  SELECT coalesce(array_agg(DISTINCT c.club_id), '{}') FROM (
    SELECT cm.club_id FROM club_memberships cm WHERE app_user_id() IS NOT NULL AND cm.profile_id IN (SELECT id FROM me)
    UNION
    -- Admin og kasserer ser deres forening, også uden et medlemskab.
    SELECT cr.club_id FROM club_roles cr JOIN profiles p ON p.id = cr.profile_id WHERE app_user_id() IS NOT NULL AND p.user_id = app_user_id()
  ) c
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_id(), app_visible_clubs() TO holdliv_app;
--> statement-breakpoint
ALTER TABLE club_memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON club_memberships TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
--> statement-breakpoint
ALTER TABLE club_roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON club_roles TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
--> statement-breakpoint
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON teams TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
--> statement-breakpoint
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON events TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
--> statement-breakpoint
ALTER TABLE membership_fees ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON membership_fees TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
--> statement-breakpoint
ALTER TABLE charges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON charges TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
--> statement-breakpoint
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON posts TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
--> statement-breakpoint
ALTER TABLE clubs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON clubs TO holdliv_app USING (id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (id = ANY (((SELECT app_visible_clubs()))::uuid[]));
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON audit_log TO holdliv_app USING (club_id = ANY (((SELECT app_visible_clubs()))::uuid[])) WITH CHECK (club_id IS NULL OR club_id = ANY (((SELECT app_visible_clubs()))::uuid[]));
--> statement-breakpoint
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON team_members TO holdliv_app USING (team_id IN (SELECT id FROM teams)) WITH CHECK (team_id IN (SELECT id FROM teams));
--> statement-breakpoint
ALTER TABLE team_modules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON team_modules TO holdliv_app USING (team_id IN (SELECT id FROM teams)) WITH CHECK (team_id IN (SELECT id FROM teams));
--> statement-breakpoint
ALTER TABLE team_tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON team_tasks TO holdliv_app USING (team_id IN (SELECT id FROM teams)) WITH CHECK (team_id IN (SELECT id FROM teams));
--> statement-breakpoint
ALTER TABLE fine_types ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON fine_types TO holdliv_app USING (team_id IN (SELECT id FROM teams)) WITH CHECK (team_id IN (SELECT id FROM teams));
--> statement-breakpoint
ALTER TABLE fines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON fines TO holdliv_app USING (team_id IN (SELECT id FROM teams)) WITH CHECK (team_id IN (SELECT id FROM teams));
--> statement-breakpoint
ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON chat_threads TO holdliv_app USING (team_id IN (SELECT id FROM teams)) WITH CHECK (team_id IN (SELECT id FROM teams));
--> statement-breakpoint
ALTER TABLE event_responses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON event_responses TO holdliv_app USING (event_id IN (SELECT id FROM events)) WITH CHECK (event_id IN (SELECT id FROM events));
--> statement-breakpoint
ALTER TABLE carpool_offers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON carpool_offers TO holdliv_app USING (event_id IN (SELECT id FROM events)) WITH CHECK (event_id IN (SELECT id FROM events));
--> statement-breakpoint
ALTER TABLE carpool_passengers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON carpool_passengers TO holdliv_app USING (event_id IN (SELECT id FROM events)) WITH CHECK (event_id IN (SELECT id FROM events));
--> statement-breakpoint
ALTER TABLE carpool_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON carpool_requests TO holdliv_app USING (event_id IN (SELECT id FROM events)) WITH CHECK (event_id IN (SELECT id FROM events));
--> statement-breakpoint
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON payments TO holdliv_app USING (charge_id IN (SELECT id FROM charges)) WITH CHECK (charge_id IN (SELECT id FROM charges));
--> statement-breakpoint
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY club_isolation ON chat_messages TO holdliv_app USING (thread_id IN (SELECT id FROM chat_threads)) WITH CHECK (thread_id IN (SELECT id FROM chat_threads));
