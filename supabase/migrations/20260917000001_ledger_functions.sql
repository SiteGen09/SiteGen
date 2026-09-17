-- Credit ledger functions.
-- Balance is always derived from SUM(ledger.credits) — never stored.
-- All functions run as regular SQL invoked with the service role by
-- server code; they are not exposed to clients (revoked below).

-- Compute current balance for a user.
CREATE OR REPLACE FUNCTION get_balance(p_user_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(credits), 0)
  FROM ledger
  WHERE user_id = p_user_id;
$$;

-- Atomically hold credits.
-- Locks the user's profile row FOR UPDATE to serialize concurrent holds,
-- computes the derived balance, rejects if the hold would overdraw.
-- Idempotent: a repeat request_id returns the existing hold outcome.
CREATE OR REPLACE FUNCTION hold_credits(
  p_user_id uuid,
  p_request_id text,
  p_estimated_credits bigint,
  p_channel_id text
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  current_balance bigint;
  existing record;
BEGIN
  IF p_estimated_credits <= 0 THEN
    RAISE EXCEPTION 'hold amount must be positive, got %', p_estimated_credits;
  END IF;

  -- Idempotency: if this request already holds, return the prior outcome.
  SELECT * INTO existing FROM ledger
  WHERE request_id = p_request_id AND kind = 'hold';
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'duplicate', true,
      'held', -existing.credits
    );
  END IF;

  -- Serialize all balance-affecting operations for this user.
  PERFORM 1 FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user not found: %', p_user_id;
  END IF;

  SELECT get_balance(p_user_id) INTO current_balance;

  IF current_balance - p_estimated_credits < 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient_credits',
      'balance', current_balance,
      'required', p_estimated_credits
    );
  END IF;

  INSERT INTO ledger (user_id, request_id, kind, credits, channel_id, meta)
  VALUES (
    p_user_id, p_request_id, 'hold', -p_estimated_credits, p_channel_id,
    jsonb_build_object('status', 'pending')
  );

  RETURN jsonb_build_object(
    'success', true,
    'balance', current_balance - p_estimated_credits,
    'held', p_estimated_credits
  );
END;
$$;

-- Settle: reverse the hold, charge the actual amount.
-- Idempotent: no-op if this request_id has already been settled or released.
CREATE OR REPLACE FUNCTION settle_credits(
  p_request_id text,
  p_actual_credits bigint,
  p_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  hold_record record;
BEGIN
  IF p_actual_credits < 0 THEN
    RAISE EXCEPTION 'settle amount must be non-negative, got %', p_actual_credits;
  END IF;

  SELECT * INTO hold_record FROM ledger
  WHERE request_id = p_request_id AND kind = 'hold';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hold not found: %', p_request_id;
  END IF;

  -- Lock user row to serialize with concurrent holds.
  PERFORM 1 FROM profiles WHERE id = hold_record.user_id FOR UPDATE;

  -- Already finalized?
  PERFORM 1 FROM ledger
  WHERE request_id IN (p_request_id || ':release', p_request_id || ':settle');
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'duplicate', true);
  END IF;

  -- Reverse the hold.
  INSERT INTO ledger (user_id, request_id, kind, credits, channel_id, meta)
  VALUES (
    hold_record.user_id, p_request_id || ':release', 'release',
    -hold_record.credits, hold_record.channel_id,
    jsonb_build_object('for', 'settle')
  );

  -- Charge the actual amount.
  INSERT INTO ledger (user_id, request_id, kind, credits, channel_id, meta)
  VALUES (
    hold_record.user_id, p_request_id || ':settle', 'settle',
    -p_actual_credits, hold_record.channel_id, p_meta
  );

  RETURN jsonb_build_object('success', true, 'charged', p_actual_credits);
END;
$$;

-- Release: reverse the hold with no charge (failed calls).
-- Idempotent: no-op if already settled or released.
CREATE OR REPLACE FUNCTION release_credits(p_request_id text)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  hold_record record;
BEGIN
  SELECT * INTO hold_record FROM ledger
  WHERE request_id = p_request_id AND kind = 'hold';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hold not found: %', p_request_id;
  END IF;

  PERFORM 1 FROM profiles WHERE id = hold_record.user_id FOR UPDATE;

  PERFORM 1 FROM ledger
  WHERE request_id IN (p_request_id || ':release', p_request_id || ':settle');
  IF FOUND THEN
    RETURN jsonb_build_object('success', true, 'duplicate', true);
  END IF;

  INSERT INTO ledger (user_id, request_id, kind, credits, channel_id, meta)
  VALUES (
    hold_record.user_id, p_request_id || ':release', 'release',
    -hold_record.credits, hold_record.channel_id,
    jsonb_build_object('for', 'release')
  );

  RETURN jsonb_build_object('success', true, 'released', -hold_record.credits);
END;
$$;

-- These functions are server-only: strip client execute grants.
REVOKE EXECUTE ON FUNCTION get_balance(uuid) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION hold_credits(uuid, text, bigint, text) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION settle_credits(text, bigint, jsonb) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION release_credits(text) FROM authenticated, anon, public;

-- Service role (server code) is the only caller of the ledger functions.
GRANT EXECUTE ON FUNCTION get_balance(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION hold_credits(uuid, text, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION settle_credits(text, bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION release_credits(text) TO service_role;

-- Client-callable balance for the dashboard: derives from own rows only.
CREATE OR REPLACE FUNCTION my_balance()
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(credits), 0)
  FROM ledger
  WHERE user_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION my_balance() TO authenticated;
