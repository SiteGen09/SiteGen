-- Rate limiting and idempotency infrastructure.
-- Both tables are server-only: RLS enabled, zero policies, grants revoked.

-- Fixed-window per-API-key rate limiting that works across instances.
CREATE TABLE "rate_limit_counters" (
  "api_key_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE CASCADE,
  "window_start" timestamp with time zone NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("api_key_id", "window_start")
);

ALTER TABLE "rate_limit_counters" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "rate_limit_counters" FROM authenticated, anon;
GRANT ALL ON "rate_limit_counters" TO service_role;

-- Atomically consume one request slot. Returns allowed + retry_after_seconds.
CREATE OR REPLACE FUNCTION consume_rate_limit(
  p_api_key_id uuid,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  win timestamptz := date_trunc('minute', now());
  new_count integer;
BEGIN
  INSERT INTO rate_limit_counters (api_key_id, window_start, count)
  VALUES (p_api_key_id, win, 1)
  ON CONFLICT (api_key_id, window_start)
  DO UPDATE SET count = rate_limit_counters.count + 1
  RETURNING count INTO new_count;

  -- Opportunistic cleanup of old windows for this key.
  DELETE FROM rate_limit_counters
  WHERE api_key_id = p_api_key_id AND window_start < now() - interval '10 minutes';

  IF new_count > p_limit THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', GREATEST(1, CEIL(EXTRACT(EPOCH FROM (win + interval '1 minute') - now()))::int)
    );
  END IF;

  RETURN jsonb_build_object('allowed', true, 'remaining', p_limit - new_count);
END;
$$;

REVOKE EXECUTE ON FUNCTION consume_rate_limit(uuid, integer) FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION consume_rate_limit(uuid, integer) TO service_role;

-- Idempotency: stores the canonical response for a given Idempotency-Key.
CREATE TABLE "idempotency_keys" (
  "key" text NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "request_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  "response_status" integer,
  "response_body" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("key", "user_id")
);

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "idempotency_keys" FROM authenticated, anon;
GRANT ALL ON "idempotency_keys" TO service_role;
