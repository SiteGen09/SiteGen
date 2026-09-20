-- Abuse strikes: one row per moderation-flagged request.
--
-- When a user accrues enough strikes inside a rolling window the gateway
-- auto-suspends them (see lib/moderation/strikes.ts). Server-only: RLS on with
-- zero policies, grants revoked, following the rate_limit/idempotency pattern.

CREATE TABLE "abuse_strikes" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "request_id" text NOT NULL,
  "categories" text[] NOT NULL DEFAULT '{}',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "abuse_strikes_user_id_created_at_idx"
  ON "abuse_strikes" ("user_id", "created_at" DESC);

ALTER TABLE "abuse_strikes" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "abuse_strikes" FROM authenticated, anon;
GRANT ALL ON "abuse_strikes" TO service_role;
GRANT USAGE, SELECT ON SEQUENCE "abuse_strikes_id_seq" TO service_role;

-- Records a strike and returns the user's strike count inside the rolling
-- window, so the caller can decide whether the threshold is reached in the
-- same round trip. Runs as the service role only.
CREATE OR REPLACE FUNCTION record_abuse_strike(
  p_user_id uuid,
  p_request_id text,
  p_categories text[],
  p_window interval DEFAULT interval '24 hours'
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  strike_count bigint;
BEGIN
  INSERT INTO abuse_strikes (user_id, request_id, categories)
  VALUES (p_user_id, p_request_id, p_categories);

  SELECT count(*) INTO strike_count
  FROM abuse_strikes
  WHERE user_id = p_user_id
    AND created_at >= now() - p_window;

  RETURN strike_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION record_abuse_strike(uuid, text, text[], interval)
  FROM authenticated, anon, public;
GRANT EXECUTE ON FUNCTION record_abuse_strike(uuid, text, text[], interval) TO service_role;