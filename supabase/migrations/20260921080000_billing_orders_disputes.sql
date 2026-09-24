CREATE TABLE IF NOT EXISTS billing_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'whop',
  payment_id text NOT NULL UNIQUE,
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  membership_id text,
  plan_id text,
  product_id text,
  kind text NOT NULL CHECK (kind IN ('subscription', 'topup')),
  status text NOT NULL DEFAULT 'paid',
  currency text NOT NULL DEFAULT 'usd',
  subtotal_cents integer NOT NULL CHECK (subtotal_cents > 0),
  total_cents integer NOT NULL CHECK (total_cents > 0),
  credits_granted bigint NOT NULL DEFAULT 0,
  credits_reversed bigint NOT NULL DEFAULT 0,
  dispute_status text NOT NULL DEFAULT 'none',
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_orders_user_created_idx ON billing_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_orders_status_idx ON billing_orders (status, dispute_status);

CREATE TABLE IF NOT EXISTS billing_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'whop',
  provider_dispute_id text NOT NULL UNIQUE,
  payment_id text,
  user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  status text NOT NULL,
  amount_cents integer,
  currency text,
  reason text,
  raw_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_disputes_user_idx ON billing_disputes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS billing_disputes_payment_idx ON billing_disputes (payment_id);

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS billing_hold_reason text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS billing_hold_at timestamptz;

REVOKE ALL ON billing_orders, billing_disputes FROM anon, authenticated;
GRANT ALL ON billing_orders, billing_disputes TO service_role;

ALTER TABLE billing_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_redemption_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_code_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS billing_hold boolean NOT NULL DEFAULT false;
ALTER TABLE billing_disputes ADD COLUMN IF NOT EXISTS provider_updated_at timestamptz;
ALTER TABLE billing_disputes ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE billing_disputes ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE billing_disputes ADD COLUMN IF NOT EXISTS review_note text;
ALTER TABLE billing_disputes ADD COLUMN IF NOT EXISTS evidence_due_at timestamptz;

-- Only trusted server operations can change billing freezes.
REVOKE UPDATE ON profiles FROM authenticated;
GRANT UPDATE(email) ON profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_whop_dispute(
 p_id text, p_payment text, p_status text, p_amount integer, p_currency text,
 p_reason text, p_updated timestamptz, p_due timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE owner uuid; prior billing_disputes%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('whop-payment-' || p_payment, 0));
 SELECT user_id INTO owner FROM billing_orders WHERE payment_id = p_payment;
 IF owner IS NULL THEN RAISE EXCEPTION 'Disputed payment has not been attributed'; END IF;
 PERFORM 1 FROM profiles WHERE id = owner FOR UPDATE;
 SELECT * INTO prior FROM billing_disputes WHERE provider_dispute_id = p_id FOR UPDATE;
 IF FOUND AND (prior.payment_id IS DISTINCT FROM p_payment OR prior.user_id IS DISTINCT FROM owner) THEN
   RAISE EXCEPTION 'Dispute attribution changed';
 END IF;
 IF FOUND AND prior.provider_updated_at >= p_updated THEN RETURN; END IF;
 INSERT INTO billing_disputes(provider_dispute_id,payment_id,user_id,status,amount_cents,currency,reason,raw_payload,provider_updated_at,evidence_due_at)
 VALUES(p_id,p_payment,owner,p_status,p_amount,p_currency,p_reason,'{}',p_updated,p_due)
 ON CONFLICT(provider_dispute_id) DO UPDATE SET status=excluded.status,amount_cents=excluded.amount_cents,
 reason=excluded.reason,provider_updated_at=excluded.provider_updated_at,evidence_due_at=excluded.evidence_due_at,updated_at=now(),
 reviewed_at=CASE WHEN billing_disputes.status IN ('won','closed','warning_closed') AND excluded.status NOT IN ('won','closed','warning_closed') THEN NULL ELSE billing_disputes.reviewed_at END;
 UPDATE billing_orders SET dispute_status=p_status,updated_at=now() WHERE payment_id=p_payment;
 -- Keep access frozen until an admin reviews the outcome. A delivery never clears a freeze.
 IF EXISTS(SELECT 1 FROM billing_disputes WHERE provider_dispute_id=p_id AND reviewed_at IS NULL) THEN
  UPDATE profiles SET billing_hold=true,billing_hold_reason='Payment dispute pending review',billing_hold_at=coalesce(billing_hold_at,now()) WHERE id=owner;
 END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_whop_dispute(text,text,text,integer,text,text,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_whop_dispute(text,text,text,integer,text,text,timestamptz,timestamptz) TO service_role;
-- Receipt IDs serialize payment grants and cumulative refund adjustments.
CREATE OR REPLACE FUNCTION public.sync_whop_purchase(
  p_payment_id text, p_user_id uuid, p_credits bigint, p_reversed bigint,
  p_kind text, p_meta jsonb
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  original ledger%ROWTYPE;
  already_reversed bigint;
  change bigint := 0;
BEGIN
  IF p_credits <= 0 OR p_reversed < 0 OR p_reversed > p_credits OR p_kind NOT IN ('topup','grant') THEN
    RAISE EXCEPTION 'Invalid purchase';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('whop-payment-' || p_payment_id, 0));
  SELECT * INTO original FROM ledger WHERE request_id = 'whop-payment-' || p_payment_id;
  IF FOUND THEN
    IF original.user_id <> p_user_id OR original.credits <> p_credits OR original.kind <> p_kind THEN
      RAISE EXCEPTION 'Purchase does not match original grant';
    END IF;
  ELSE
    INSERT INTO ledger(user_id, request_id, kind, credits, meta)
      VALUES (p_user_id, 'whop-payment-' || p_payment_id, p_kind, p_credits, p_meta);
    change := p_credits;
  END IF;
  SELECT coalesce(-sum(credits), 0) INTO already_reversed FROM ledger
    WHERE user_id = p_user_id AND kind = 'refund' AND meta->>'payment_id' = p_payment_id
      AND meta->>'source' = 'whop';
  IF p_reversed > already_reversed THEN
    INSERT INTO ledger(user_id, request_id, kind, credits, meta) VALUES
      (p_user_id, 'whop-refund-' || p_payment_id || '-' || p_reversed, 'refund',
       -(p_reversed - already_reversed), p_meta);
    change := change - (p_reversed - already_reversed);
  END IF;
  IF p_meta ? 'total_cents' THEN
    INSERT INTO billing_orders(payment_id,user_id,membership_id,plan_id,product_id,kind,status,
      subtotal_cents,total_cents,credits_granted,credits_reversed,metadata)
    VALUES(p_payment_id,p_user_id,p_meta->>'membership_id',p_meta->>'plan_id',p_meta->>'product_id',
      CASE WHEN p_kind='topup' THEN 'topup' ELSE 'subscription' END,
      CASE WHEN greatest(p_reversed,already_reversed)>=p_credits THEN 'refunded' WHEN greatest(p_reversed,already_reversed)>0 THEN 'partially_refunded' ELSE 'paid' END,
      (p_meta->>'amount_cents')::integer,(p_meta->>'total_cents')::integer,p_credits,greatest(p_reversed,already_reversed),p_meta)
    ON CONFLICT(payment_id) DO UPDATE SET
      status=excluded.status,credits_reversed=excluded.credits_reversed,updated_at=now();
  END IF;
  RETURN change;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_whop_purchase(text, uuid, bigint, bigint, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_whop_purchase(text, uuid, bigint, bigint, text, jsonb) TO service_role;


CREATE OR REPLACE FUNCTION public.guard_admit(p_user uuid, p_request text, p_ip text,
  p_account_rpm integer, p_ip_rpm integer, p_concurrency integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  tick timestamptz := clock_timestamp();
  minute_start timestamptz := date_trunc('minute', tick);
  account_status text;
  blocked timestamptz;
  n integer;
BEGIN
  IF p_account_rpm < 1 OR p_ip_rpm < 1 OR p_concurrency < 1 THEN
    RAISE EXCEPTION 'invalid guard limits';
  END IF;
  -- A common lock order serializes simultaneous requests across app instances.
  IF p_ip IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('guard-ip:' || p_ip, 0));
  END IF;
  SELECT CASE WHEN billing_hold THEN 'suspended' ELSE status END INTO account_status FROM profiles WHERE id = p_user FOR UPDATE;
  IF account_status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'inactive');
  END IF;
  SELECT blocked_until INTO blocked FROM guard_cooldowns WHERE user_id = p_user;
  IF blocked > tick THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'cooldown', 'retry_after', ceil(extract(epoch FROM blocked - tick)));
  END IF;

  INSERT INTO guard_counters AS c VALUES ('user:' || p_user, minute_start, 1)
  ON CONFLICT (bucket) DO UPDATE SET window_start = minute_start,
    hits = CASE WHEN c.window_start = minute_start THEN c.hits + 1 ELSE 1 END
  RETURNING hits INTO n;
  IF n > p_account_rpm THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'rate', 'retry_after', 60);
  END IF;
  IF p_ip IS NOT NULL THEN
    INSERT INTO guard_counters AS c VALUES ('ip:' || p_ip, minute_start, 1)
    ON CONFLICT (bucket) DO UPDATE SET window_start = minute_start,
      hits = CASE WHEN c.window_start = minute_start THEN c.hits + 1 ELSE 1 END
    RETURNING hits INTO n;
    IF n > p_ip_rpm THEN
      RETURN jsonb_build_object('allowed', false, 'reason', 'rate', 'retry_after', 60);
    END IF;
  END IF;
  DELETE FROM guard_leases WHERE user_id = p_user AND expires_at <= tick;
  -- Async media still occupies a slot after its HTTP response has returned.
  SELECT count(*) INTO n FROM (
    SELECT request_id FROM guard_leases WHERE user_id = p_user
    UNION
    SELECT request_id FROM media_jobs WHERE user_id = p_user AND status IN ('queued', 'running')
  ) active;
  IF n >= p_concurrency THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'concurrency', 'retry_after', 10);
  END IF;
  -- Longer than the maximum route duration; abandoned leases recover automatically.
  INSERT INTO guard_leases VALUES (p_request, p_user, tick + interval '10 minutes');
  DELETE FROM guard_counters WHERE window_start < tick - interval '1 day';
  RETURN jsonb_build_object('allowed', true);
END;
$$;


