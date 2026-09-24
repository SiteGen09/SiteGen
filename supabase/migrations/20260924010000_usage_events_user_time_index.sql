-- Per-user usage reads (admin user detail page, users list consumption and
-- last-request columns, the dashboard usage page) filter one user_id and then
-- a created_at window or a newest-first LIMIT. With only a user_id index each
-- of those reads and sorts every row that user ever produced.
--
-- The composite index answers both shapes directly, and its leading user_id
-- still serves the RLS usage_events_select_own policy and the ON DELETE
-- CASCADE from profiles, so the single-column index is redundant and dropped
-- to avoid maintaining two indexes on every usage write.
--
-- The migration runner wraps each file in a transaction, so this is a plain
-- CREATE INDEX: it blocks usage writes while it builds, which is brief at the
-- current table size.
CREATE INDEX IF NOT EXISTS usage_events_user_created_idx
  ON usage_events (user_id, created_at DESC);
DROP INDEX IF EXISTS usage_events_user_id_idx;
