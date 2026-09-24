CREATE TABLE IF NOT EXISTS credit_redemption_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  code_prefix text NOT NULL,
  label text,
  credits bigint NOT NULL CHECK (credits > 0 AND credits <= 100000000),
  max_redemptions integer NOT NULL DEFAULT 1 CHECK (max_redemptions > 0 AND max_redemptions <= 100000),
  redemption_count integer NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  expires_at timestamptz,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_redemption_codes_active_idx
  ON credit_redemption_codes (active, expires_at);

CREATE TABLE IF NOT EXISTS credit_code_redemptions (
  id bigserial PRIMARY KEY,
  code_id uuid NOT NULL REFERENCES credit_redemption_codes(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  request_id text NOT NULL UNIQUE,
  credits bigint NOT NULL CHECK (credits > 0),
  meta jsonb,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code_id, user_id)
);

CREATE INDEX IF NOT EXISTS credit_code_redemptions_user_idx
  ON credit_code_redemptions (user_id, redeemed_at DESC);

REVOKE ALL ON credit_redemption_codes, credit_code_redemptions FROM anon, authenticated;
GRANT ALL ON credit_redemption_codes, credit_code_redemptions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE credit_code_redemptions_id_seq TO service_role;
