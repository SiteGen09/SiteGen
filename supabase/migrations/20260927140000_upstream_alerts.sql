-- Admin alerts when an upstream provider starts failing.
--
-- usage_events keeps one row per request with its final outcome, so a failed
-- attempt that fallback rescued on another provider is invisible there. Each
-- failed upstream attempt is recorded here instead (lib/ai/attempt-failures.ts);
-- the notification scanner compares it with successful requests per provider
-- and family, alerts admins over a threshold, and prunes old rows.
CREATE TABLE public.upstream_attempt_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id text NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
  http_status integer,
  error_code text NOT NULL CHECK (char_length(error_code) <= 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX upstream_attempt_failures_created_idx ON public.upstream_attempt_failures (created_at);
ALTER TABLE public.upstream_attempt_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.upstream_attempt_failures FROM PUBLIC, anon, authenticated;

-- Alerts are personal notifications to each administrator.
ALTER TABLE public.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'model_added', 'model_removed', 'price_change', 'announcement',
  'low_balance', 'key_expiring', 'key_quota', 'support_reply', 'upstream_alert'));
