-- Extends the existing auth.users-backed profiles, append-only ledger and entitlements.
-- Apply this migration in a transaction before deploying the new webhook handler.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS credits bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS subscription_tier text NOT NULL DEFAULT 'free';
ALTER TABLE public.profiles ADD CONSTRAINT profiles_subscription_tier_check
  CHECK (subscription_tier IN ('free', 'starter', 'pro', 'max'));
ALTER TABLE public.entitlements ADD COLUMN IF NOT EXISTS whop_observed_at timestamptz;

UPDATE public.profiles p
SET credits = COALESCE((SELECT SUM(l.credits) FROM public.ledger l WHERE l.user_id = p.id), 0),
    subscription_tier = COALESCE((SELECT CASE WHEN e.status IN ('active','past_due') THEN e.plan_key ELSE 'free' END
      FROM public.entitlements e WHERE e.user_id = p.id), 'free');
-- Existing column-level email permission is retained; balances/tier are server-owned.
REVOKE UPDATE ON public.profiles FROM PUBLIC, anon, authenticated;
GRANT UPDATE(email) ON public.profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.sync_profile_credits()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.profiles SET credits = credits + NEW.credits WHERE id = NEW.user_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sync_profile_credits_after_insert
  AFTER INSERT ON public.ledger FOR EACH ROW EXECUTE FUNCTION public.sync_profile_credits();

CREATE OR REPLACE FUNCTION public.sync_profile_subscription_tier()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.profiles SET subscription_tier = 'free' WHERE id = OLD.user_id;
    RETURN OLD;
  END IF;
  UPDATE public.profiles
  SET subscription_tier = CASE WHEN NEW.status IN ('active','past_due') THEN NEW.plan_key ELSE 'free' END
  WHERE id = NEW.user_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sync_profile_subscription_tier_after_write
  AFTER INSERT OR UPDATE OR DELETE ON public.entitlements
  FOR EACH ROW EXECUTE FUNCTION public.sync_profile_subscription_tier();
REVOKE ALL ON FUNCTION public.sync_profile_credits(), public.sync_profile_subscription_tier()
  FROM PUBLIC, anon, authenticated;

CREATE TABLE public.payments_log (
  id text PRIMARY KEY,
  delivery_id text NOT NULL UNIQUE,
  -- Provider payment id. A payment can have several webhook deliveries
  -- (for example a success followed by a refund), so this is indexed rather
  -- than globally unique; successful fulfillment is deduped per payment below.
  payment_id text CHECK (payment_id IS NULL OR payment_id ~ '^pay_[A-Za-z0-9_-]+$'),
  user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  amount numeric(14, 2) NOT NULL DEFAULT 0,
  credits_added bigint NOT NULL DEFAULT 0,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  handled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_log_user_created_idx ON public.payments_log(user_id, created_at DESC);
CREATE INDEX payments_log_payment_event_idx ON public.payments_log(payment_id, event_type);
ALTER TABLE public.payments_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payments_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.payments_log TO service_role;

-- Atomic increments share the ledger's global unique request key. Reusing a key
-- for a different user, quantity or entry kind is an error, not a silent success.
CREATE OR REPLACE FUNCTION public.increment_credits(
  user_id uuid, amount bigint, request_id text DEFAULT NULL,
  entry_kind text DEFAULT 'grant', metadata jsonb DEFAULT '{}'::jsonb
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  inserted integer;
  credit_key text := COALESCE(request_id, 'credit-' || gen_random_uuid()::text);
  original public.ledger%ROWTYPE;
BEGIN
  IF user_id IS NULL OR amount IS NULL OR amount = 0 OR entry_kind IS NULL
     OR entry_kind NOT IN ('grant','topup','refund')
     OR (entry_kind IN ('grant','topup') AND amount < 0)
     OR (entry_kind = 'refund' AND amount > 0) OR length(credit_key) = 0 THEN
    RAISE EXCEPTION 'Invalid credit increment';
  END IF;
  PERFORM 1 FROM public.profiles p WHERE p.id = increment_credits.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  INSERT INTO public.ledger(user_id, request_id, kind, credits, meta)
  VALUES(increment_credits.user_id, credit_key, entry_kind, amount, metadata)
  ON CONFLICT ON CONSTRAINT ledger_request_id_key DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 1 THEN RETURN amount; END IF;
  SELECT * INTO STRICT original FROM public.ledger l WHERE l.request_id = credit_key;
  IF original.user_id IS DISTINCT FROM user_id OR original.credits IS DISTINCT FROM amount
     OR original.kind IS DISTINCT FROM entry_kind THEN
    RAISE EXCEPTION 'Credit request does not match original grant';
  END IF;
  RETURN 0;
END;
$$;
REVOKE ALL ON FUNCTION public.increment_credits(uuid,bigint,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.increment_credits(uuid,bigint,text,text,jsonb) TO service_role;

-- Preserve existing refund/dispute accounting. New receipts must be explicitly
-- authorized by payment.succeeded before they can grant credits. Refunds and
-- disputes arriving first record the order and cumulative refund without a grant.
CREATE OR REPLACE FUNCTION public.sync_whop_purchase(
  p_payment_id text, p_user_id uuid, p_credits bigint, p_reversed bigint,
  p_kind text, p_meta jsonb
) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  original public.ledger%ROWTYPE;
  prior public.billing_orders%ROWTYPE;
  already_reversed bigint := 0;
  target_reversed bigint;
  change bigint := 0;
  has_grant boolean;
  authorized boolean := COALESCE(p_meta->>'confirmed_event_type', '') = 'payment.succeeded';
BEGIN
  IF p_payment_id IS NULL OR p_payment_id !~ '^pay_[A-Za-z0-9_-]+$' OR p_user_id IS NULL
     OR p_credits IS NULL OR p_credits <= 0 OR p_reversed IS NULL OR p_reversed < 0
     OR p_reversed > p_credits OR p_kind IS NULL OR p_kind NOT IN ('topup','grant') THEN
    RAISE EXCEPTION 'Invalid purchase';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('whop-payment-' || p_payment_id, 0));
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  SELECT * INTO original FROM public.ledger WHERE request_id = 'whop-payment-' || p_payment_id;
  has_grant := FOUND;
  IF has_grant AND (original.user_id IS DISTINCT FROM p_user_id OR original.credits IS DISTINCT FROM p_credits
      OR original.kind IS DISTINCT FROM p_kind) THEN
    RAISE EXCEPTION 'Purchase does not match original grant';
  END IF;
  SELECT * INTO prior FROM public.billing_orders WHERE payment_id = p_payment_id;
  IF FOUND AND prior.user_id IS DISTINCT FROM p_user_id THEN RAISE EXCEPTION 'Purchase attribution changed'; END IF;
  target_reversed := greatest(p_reversed, COALESCE(prior.credits_reversed, 0),
    COALESCE((prior.metadata->>'refunded_credits')::bigint, 0));
  IF target_reversed > p_credits THEN RAISE EXCEPTION 'Refund exceeds purchase'; END IF;
  IF NOT has_grant AND authorized THEN
    change := public.increment_credits(p_user_id, p_credits, 'whop-payment-' || p_payment_id, p_kind, p_meta);
    has_grant := true;
  END IF;
  SELECT COALESCE(-sum(credits), 0) INTO already_reversed FROM public.ledger
  WHERE user_id = p_user_id AND kind = 'refund' AND meta->>'payment_id' = p_payment_id AND meta->>'source' = 'whop';
  target_reversed := greatest(target_reversed, already_reversed);
  IF has_grant AND target_reversed > already_reversed THEN
    change := change + public.increment_credits(p_user_id, -(target_reversed - already_reversed),
      'whop-refund-' || p_payment_id || '-' || target_reversed, 'refund', p_meta);
  END IF;
  IF p_meta ? 'total_cents' THEN
    INSERT INTO public.billing_orders(payment_id,user_id,membership_id,plan_id,product_id,kind,status,
      subtotal_cents,total_cents,credits_granted,credits_reversed,metadata)
    VALUES(p_payment_id,p_user_id,p_meta->>'membership_id',p_meta->>'plan_id',p_meta->>'product_id',
      CASE WHEN p_kind = 'topup' THEN 'topup' ELSE 'subscription' END,
      CASE WHEN NOT has_grant THEN 'awaiting_payment_confirmation' WHEN target_reversed >= p_credits THEN 'refunded'
        WHEN target_reversed > 0 THEN 'partially_refunded' ELSE 'paid' END,
      (p_meta->>'amount_cents')::integer,(p_meta->>'total_cents')::integer,
      CASE WHEN has_grant THEN p_credits ELSE 0 END, CASE WHEN has_grant THEN target_reversed ELSE 0 END,
      p_meta || jsonb_build_object('refunded_credits', target_reversed))
    ON CONFLICT(payment_id) DO UPDATE SET status=excluded.status, credits_granted=excluded.credits_granted,
      credits_reversed=excluded.credits_reversed, metadata=excluded.metadata, updated_at=now();
  END IF;
  RETURN change;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_whop_purchase(text,uuid,bigint,bigint,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_whop_purchase(text,uuid,bigint,bigint,text,jsonb) TO service_role;

-- A single transaction claims the delivery, applies all effects, and writes its
-- result. If anything fails, the claim rolls back and Whop can retry safely.
CREATE OR REPLACE FUNCTION public.fulfill_whop_event(
  p_id text, p_delivery_id text, p_type text, p_hash text, p_payload jsonb,
  p_purchase jsonb DEFAULT NULL, p_membership jsonb DEFAULT NULL, p_dispute jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  previous public.payments_log%ROWTYPE;
  entitlement public.entitlements%ROWTYPE;
  owner uuid;
  membership_owner uuid;
  payment_key text;
  change bigint := 0;
  charged numeric(14,2) := 0;
  event_handled boolean := false;
  observed timestamptz;
BEGIN
  IF p_id IS NULL OR length(p_id) = 0 OR p_delivery_id IS NULL OR length(p_delivery_id) = 0
    OR p_type IS NULL OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid event'; END IF;
  payment_key := NULLIF(COALESCE(p_purchase->>'payment_id', p_dispute->>'payment_id'), '');
  PERFORM pg_advisory_xact_lock(hashtextextended('whop-delivery-' || p_delivery_id, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('whop-event-' || p_id, 0));
  IF payment_key IS NOT NULL AND p_type IN ('payment.succeeded','payment_succeeded') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('whop-payment-event-' || payment_key, 0));
    IF EXISTS (
      SELECT 1 FROM public.payments_log
      WHERE payment_id = payment_key
        AND event_type IN ('payment.succeeded','payment_succeeded')
        AND handled
    ) THEN
      RETURN jsonb_build_object('duplicate',true,'handled',true,'creditsAdded',0);
    END IF;
  END IF;
  SELECT * INTO previous FROM public.payments_log WHERE id = p_id OR delivery_id = p_delivery_id LIMIT 1;
  IF FOUND THEN
    IF previous.id <> p_id OR previous.payload_hash <> p_hash OR previous.event_type <> p_type THEN
      RAISE EXCEPTION 'Webhook identity conflict';
    END IF;
    RETURN jsonb_build_object('duplicate',true,'handled',previous.handled,'creditsAdded',0);
  END IF;
  INSERT INTO public.payments_log(id,delivery_id,payment_id,event_type,payload_hash)
    VALUES(p_id,p_delivery_id,payment_key,p_type,p_hash);
  IF p_purchase IS NOT NULL THEN
    owner := (p_purchase->>'user_id')::uuid;
    change := public.sync_whop_purchase(p_purchase->>'payment_id',owner,
      (p_purchase->>'credits')::bigint,(p_purchase->>'reversed')::bigint,
      p_purchase->>'kind',(p_purchase->'meta') || jsonb_build_object('confirmed_event_type',
        CASE WHEN p_type IN ('payment.succeeded','payment_succeeded') THEN 'payment.succeeded' ELSE p_type END));
    charged := (p_purchase->'meta'->>'total_cents')::numeric / 100;
    event_handled := true;
  END IF;
  IF p_membership IS NOT NULL THEN
    membership_owner := (p_membership->>'user_id')::uuid;
    IF owner IS NOT NULL AND owner <> membership_owner THEN RAISE EXCEPTION 'Membership attribution mismatch'; END IF;
    owner := membership_owner;
    IF p_membership->>'plan_key' NOT IN ('starter','pro','max') OR p_membership->>'status' NOT IN ('active','past_due','inactive') THEN
      RAISE EXCEPTION 'Invalid membership';
    END IF;
    PERFORM 1 FROM public.profiles WHERE id = owner FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
    observed := (p_membership->>'observed_at')::timestamptz;
    SELECT * INTO entitlement FROM public.entitlements WHERE user_id = owner;
    IF (entitlement.whop_observed_at IS NULL OR observed >= entitlement.whop_observed_at)
      AND NOT (entitlement.external_id IS NOT NULL AND entitlement.external_id <> p_membership->>'external_id'
        AND p_membership->>'status' <> 'active') THEN
      INSERT INTO public.entitlements(user_id,plan_key,status,provider,external_id,current_period_end,monthly_credits,whop_observed_at,updated_at)
      VALUES(owner,p_membership->>'plan_key',p_membership->>'status','whop',p_membership->>'external_id',
        COALESCE((p_membership->>'current_period_end')::timestamptz,entitlement.current_period_end),
        (p_membership->>'monthly_credits')::bigint,observed,now())
      ON CONFLICT(user_id) DO UPDATE SET plan_key=excluded.plan_key,status=excluded.status,provider=excluded.provider,
        external_id=excluded.external_id,current_period_end=excluded.current_period_end,monthly_credits=excluded.monthly_credits,
        whop_observed_at=excluded.whop_observed_at,updated_at=now();
    END IF;
    event_handled := true;
  END IF;
  IF p_dispute IS NOT NULL THEN
    PERFORM public.sync_whop_dispute(p_dispute->>'id',p_dispute->>'payment_id',p_dispute->>'status',
      (p_dispute->>'amount_cents')::integer,p_dispute->>'currency',p_dispute->>'reason',
      (p_dispute->>'updated_at')::timestamptz,(p_dispute->>'evidence_due_at')::timestamptz);
    event_handled := true;
  END IF;
  INSERT INTO public.billing_events(event_id,provider,kind,payload)
    VALUES(p_id,'whop',p_type,p_payload) ON CONFLICT(event_id) DO NOTHING;
  UPDATE public.payments_log SET user_id=owner,amount=charged,credits_added=change,handled=event_handled WHERE id=p_id;
  RETURN jsonb_build_object('duplicate',false,'handled',event_handled,'creditsAdded',change);
END;
$$;
REVOKE ALL ON FUNCTION public.fulfill_whop_event(text,text,text,text,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fulfill_whop_event(text,text,text,text,jsonb,jsonb,jsonb,jsonb) TO service_role;

-- Bound checkout configuration creation across server instances.
CREATE OR REPLACE FUNCTION public.admit_whop_checkout(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE tick timestamptz := date_trunc('minute', clock_timestamp()); n integer;
BEGIN
  PERFORM 1 FROM public.profiles WHERE id=p_user_id AND status='active' AND NOT billing_hold FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'reason','inactive'); END IF;
  INSERT INTO public.guard_counters AS c(bucket,window_start,hits) VALUES('checkout:' || p_user_id,tick,1)
  ON CONFLICT(bucket) DO UPDATE SET window_start=tick,hits=CASE WHEN c.window_start=tick THEN c.hits+1 ELSE 1 END
  RETURNING hits INTO n;
  RETURN jsonb_build_object('allowed',n<=5,'reason',CASE WHEN n>5 THEN 'rate_limited' ELSE 'ok' END);
END;
$$;
REVOKE ALL ON FUNCTION public.admit_whop_checkout(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admit_whop_checkout(uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
