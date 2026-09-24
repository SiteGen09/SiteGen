-- These six tables were created after the initial schema with a GRANT but no
-- REVOKE, so hosted projects kept Supabase's default privileges: anon and
-- authenticated hold ALL on them. RLS stops row access, but TRUNCATE ignores
-- RLS, and no client role needs REFERENCES or TRIGGER. Reset them to the
-- explicit matrix the initial schema uses. service_role is not touched.
REVOKE ALL ON chat_conversations, chat_messages, media_jobs, model_health_checks,
  sources, user_routing_preferences FROM PUBLIC, anon, authenticated;

-- The chat page, the chat workspace and the chat route's history load read
-- threads with the session client. Only the billed server pipeline writes turns.
GRANT SELECT ON chat_conversations, chat_messages TO authenticated;

-- The app lists sources with the service client, but the routing_insert and
-- routing_update WITH CHECK subqueries read sources as the calling role.
GRANT SELECT ON sources TO authenticated;

-- saveRoutingAction upserts with the session client so RLS re-checks family,
-- modality and plan. The upsert needs SELECT, INSERT and UPDATE. Clearing a
-- preference goes through the service client, so DELETE is not granted.
GRANT SELECT, INSERT, UPDATE ON user_routing_preferences TO authenticated;

-- media_jobs and model_health_checks are service-role only. /api/media/[id]
-- loads jobs with the service client after checking ownership. A direct grant
-- would also expose callback_token. media_jobs_read stays in place, so granting
-- SELECT again is enough if the browser ever reads jobs directly.
