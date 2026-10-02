-- Referral program. Every user can share a code. When someone they referred
-- pays, the referrer earns promotional credits into a rewards wallet. A reward
-- unlocks after a hold, follows refunds and disputes on the payment it came
-- from, and only becomes spendable when the referrer transfers it to their
-- balance. Referred users get a one-off bonus on their first top-up.
--
-- Cash payouts are an admin-only bookkeeping record: the money is sent outside
-- the app and this only takes the matching credits out of the wallet (or back
-- out of the balance) and remembers who paid what.
--
-- Every table here is service-role only. Pages read it on the server after
-- authenticating the user.

ALTER TABLE public.ledger DROP CONSTRAINT IF EXISTS ledger_kind_check;
ALTER TABLE public.ledger ADD CONSTRAINT ledger_kind_check
  CHECK (kind IN ('topup', 'grant', 'hold', 'settle', 'release', 'refund', 'referral'));

-- One row. Rates are basis points (300 = 3%). Changes apply to payments made
-- after the change; existing rewards keep the rate and unlock time they got.
CREATE TABLE public.referral_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  enabled boolean NOT NULL DEFAULT true,
  commission_bps integer NOT NULL DEFAULT 300 CHECK (commission_bps BETWEEN 0 AND 5000),
  bonus_bps integer NOT NULL DEFAULT 500 CHECK (bonus_bps BETWEEN 0 AND 5000),
  hold_days integer NOT NULL DEFAULT 7 CHECK (hold_days BETWEEN 0 AND 180),
  -- How long after signup a referred user's payments still earn. NULL = forever.
  window_days integer DEFAULT 365 CHECK (window_days IS NULL OR window_days BETWEEN 1 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
INSERT INTO public.referral_settings DEFAULT VALUES;

-- A user's own code, created the first time they open the referral page.
CREATE TABLE public.referral_accounts (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{4,16}$'),
  -- Admin override of referral_settings.commission_bps for this referrer.
  commission_bps integer CHECK (commission_bps IS NULL OR commission_bps BETWEEN 0 AND 5000),
  -- Frozen referrers earn nothing new and cannot transfer or be paid out.
  frozen boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.referrals (
  referred_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  referrer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  code text NOT NULL,
  -- The top-up that received the new-user bonus, once one has.
  bonus_payment_id text,
  bonus_credits bigint NOT NULL DEFAULT 0 CHECK (bonus_credits >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (referred_id <> referrer_id)
);
CREATE INDEX referrals_referrer_idx ON public.referrals(referrer_id, created_at DESC);

-- One reward per paid order. `credits` is what the reward is worth now:
-- full_credits scaled down by refunds, and zero while the payment is disputed.
CREATE TABLE public.referral_commissions (
  payment_id text PRIMARY KEY,
  referrer_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  referred_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  order_kind text NOT NULL CHECK (order_kind IN ('topup', 'subscription')),
  base_cents integer NOT NULL CHECK (base_cents > 0),
  rate_bps integer NOT NULL CHECK (rate_bps > 0),
  full_credits bigint NOT NULL CHECK (full_credits >= 0),
  credits bigint NOT NULL CHECK (credits >= 0 AND credits <= full_credits),
  available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX referral_commissions_referrer_idx ON public.referral_commissions(referrer_id, created_at DESC);

-- Credits leaving the rewards wallet (source 'wallet'), or referral credits an
-- admin took back out of the balance for a cash payout (source 'balance').
CREATE TABLE public.referral_wallet_moves (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('transfer', 'cash_payout')),
  source text NOT NULL DEFAULT 'wallet' CHECK (source IN ('wallet', 'balance')),
  credits bigint NOT NULL CHECK (credits > 0),
  ledger_request_id text UNIQUE,
  cash_cents integer CHECK (cash_cents IS NULL OR cash_cents >= 0),
  cash_currency text,
  method text,
  reference text,
  note text,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'cash_payout' OR source = 'wallet'),
  CHECK (kind = 'transfer' OR (cash_cents IS NOT NULL AND method IS NOT NULL))
);
CREATE INDEX referral_wallet_moves_user_idx ON public.referral_wallet_moves(user_id, created_at DESC);

ALTER TABLE public.referral_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_wallet_moves ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.referral_settings, public.referral_accounts, public.referrals,
  public.referral_commissions, public.referral_wallet_moves FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.referral_settings, public.referral_accounts, public.referrals,
  public.referral_commissions, public.referral_wallet_moves TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.referral_wallet_moves_id_seq TO service_role;

-- Codes are not secrets, so random() is enough. No 0/O or 1/I to misread.
CREATE OR REPLACE FUNCTION public.ensure_referral_account(p_user uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
  existing text;
BEGIN
  SELECT code INTO existing FROM public.referral_accounts WHERE user_id = p_user;
  IF FOUND THEN RETURN existing; END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'User not found'; END IF;
  LOOP
    candidate := '';
    FOR i IN 1..8 LOOP
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
    END LOOP;
    BEGIN
      INSERT INTO public.referral_accounts(user_id, code) VALUES (p_user, candidate)
      ON CONFLICT (user_id) DO NOTHING;
      SELECT code INTO STRICT existing FROM public.referral_accounts WHERE user_id = p_user;
      RETURN existing;
    EXCEPTION WHEN unique_violation THEN
      -- Another user already has this code; draw again.
    END;
  END LOOP;
END;
$$;

-- Attribution happens once, right after signup. An older account, or one that
-- has already paid, cannot attach itself to a referrer later.
CREATE OR REPLACE FUNCTION public.claim_referral(p_user uuid, p_code text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  normalized text := upper(btrim(COALESCE(p_code, '')));
  referrer public.referral_accounts%ROWTYPE;
  joined timestamptz;
BEGIN
  IF normalized !~ '^[A-Z0-9]{4,16}$' THEN RETURN 'invalid_code'; END IF;
  IF NOT (SELECT enabled FROM public.referral_settings) THEN RETURN 'disabled'; END IF;
  SELECT created_at INTO joined FROM public.profiles WHERE id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown_user'; END IF;
  IF EXISTS (SELECT 1 FROM public.referrals WHERE referred_id = p_user) THEN RETURN 'already_referred'; END IF;
  SELECT * INTO referrer FROM public.referral_accounts WHERE code = normalized;
  IF NOT FOUND OR referrer.frozen THEN RETURN 'invalid_code'; END IF;
  IF referrer.user_id = p_user THEN RETURN 'self_referral'; END IF;
  IF joined < now() - interval '1 day'
     OR EXISTS (SELECT 1 FROM public.billing_orders WHERE user_id = p_user) THEN
    RETURN 'too_late';
  END IF;
  INSERT INTO public.referrals(referred_id, referrer_id, code) VALUES (p_user, referrer.user_id, normalized);
  RETURN 'ok';
END;
$$;

-- Applies one paid order to the referral program. Called from the
-- billing_orders trigger, which already runs under the payment's advisory lock.
CREATE OR REPLACE FUNCTION public.apply_referral_order(o public.billing_orders)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  cfg public.referral_settings%ROWTYPE;
  ref public.referrals%ROWTYPE;
  account public.referral_accounts%ROWTYPE;
  reward public.referral_commissions%ROWTYPE;
  rate integer;
  full_reward bigint;
  kept numeric;
  disputed boolean := o.dispute_status NOT IN ('none', 'won', 'warning_closed');
  bonus_target bigint;
  bonus_given bigint;
BEGIN
  IF o.user_id IS NULL OR o.credits_granted <= 0 THEN RETURN; END IF;
  SELECT * INTO ref FROM public.referrals WHERE referred_id = o.user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO cfg FROM public.referral_settings;
  kept := greatest(o.credits_granted - o.credits_reversed, 0)::numeric / o.credits_granted;

  -- Referrer reward. One credit is $0.0001, so a cent is 100 credits.
  SELECT * INTO reward FROM public.referral_commissions WHERE payment_id = o.payment_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT * INTO account FROM public.referral_accounts WHERE user_id = ref.referrer_id;
    rate := COALESCE(account.commission_bps, cfg.commission_bps);
    IF cfg.enabled AND NOT COALESCE(account.frozen, false) AND rate > 0
       AND (cfg.window_days IS NULL OR o.created_at < ref.created_at + make_interval(days => cfg.window_days)) THEN
      full_reward := floor(o.subtotal_cents::numeric * 100 * rate / 10000);
      IF full_reward > 0 THEN
        INSERT INTO public.referral_commissions(payment_id, referrer_id, referred_id, order_kind, base_cents,
          rate_bps, full_credits, credits, available_at)
        VALUES (o.payment_id, ref.referrer_id, o.user_id, o.kind, o.subtotal_cents, rate, full_reward,
          CASE WHEN disputed THEN 0 ELSE floor(full_reward * kept) END,
          now() + make_interval(days => cfg.hold_days));
      END IF;
    END IF;
  ELSE
    UPDATE public.referral_commissions
    SET credits = CASE WHEN disputed THEN 0 ELSE floor(reward.full_credits * kept) END, updated_at = now()
    WHERE payment_id = o.payment_id;
  END IF;

  -- New-user bonus on the first top-up, granted at once and reduced if that
  -- top-up is refunded, exactly like the purchased credits it rides on.
  IF o.kind <> 'topup' THEN RETURN; END IF;
  IF ref.bonus_payment_id IS NULL THEN
    IF NOT cfg.enabled OR cfg.bonus_bps <= 0 OR o.credits_reversed > 0 OR disputed THEN RETURN; END IF;
    UPDATE public.referrals SET bonus_payment_id = o.payment_id,
      bonus_credits = floor(o.credits_granted::numeric * cfg.bonus_bps / 10000)
    WHERE referred_id = o.user_id RETURNING * INTO ref;
  ELSIF ref.bonus_payment_id <> o.payment_id THEN
    RETURN;
  END IF;
  bonus_target := floor(ref.bonus_credits * kept);
  SELECT COALESCE(sum(credits), 0) INTO bonus_given FROM public.ledger
  WHERE user_id = o.user_id AND kind = 'referral' AND meta->>'source' = 'referral_bonus'
    AND meta->>'payment_id' = o.payment_id;
  IF bonus_target <> bonus_given THEN
    INSERT INTO public.ledger(user_id, request_id, kind, credits, meta)
    VALUES (o.user_id, 'referral-bonus-' || o.payment_id || '-' || gen_random_uuid(), 'referral',
      bonus_target - bonus_given,
      jsonb_build_object('source', 'referral_bonus', 'payment_id', o.payment_id,
        'reason', CASE WHEN bonus_given = 0 THEN 'Referral welcome bonus' ELSE 'Referral welcome bonus adjusted for refund' END));
  END IF;
END;
$$;

-- A referral bug must never block a payment from being fulfilled: the
-- referral work runs in its own subtransaction and is dropped on error.
CREATE OR REPLACE FUNCTION public.billing_orders_referral_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  BEGIN
    PERFORM public.apply_referral_order(NEW);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'referral accounting skipped for %: %', NEW.payment_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;
CREATE TRIGGER billing_orders_referral
  AFTER INSERT OR UPDATE OF credits_granted, credits_reversed, dispute_status ON public.billing_orders
  FOR EACH ROW EXECUTE FUNCTION public.billing_orders_referral_trigger();

-- Wallet figures for one referrer. `available` can go below zero when a
-- reward is refunded after it was transferred; later rewards pay that back.
CREATE OR REPLACE FUNCTION public.referral_wallet(p_user uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH earned AS (
    SELECT COALESCE(sum(credits) FILTER (WHERE available_at > now()), 0) AS pending,
           COALESCE(sum(credits) FILTER (WHERE available_at <= now()), 0) AS matured,
           COALESCE(sum(credits), 0) AS total
    FROM public.referral_commissions WHERE referrer_id = p_user
  ), moved AS (
    SELECT COALESCE(sum(credits) FILTER (WHERE source = 'wallet'), 0) AS from_wallet,
           COALESCE(sum(credits) FILTER (WHERE kind = 'transfer'), 0) AS transferred,
           COALESCE(sum(credits) FILTER (WHERE kind = 'cash_payout' AND source = 'balance'), 0) AS clawed_back,
           COALESCE(sum(credits) FILTER (WHERE kind = 'cash_payout'), 0) AS paid_out
    FROM public.referral_wallet_moves WHERE user_id = p_user
  )
  SELECT jsonb_build_object(
    'pending', earned.pending,
    'available', earned.matured - moved.from_wallet,
    'total_earned', earned.total,
    'transferred', moved.transferred,
    'paid_out', moved.paid_out,
    -- Referral credits already in the balance that a cash payout may take back.
    'reclaimable', greatest(moved.transferred - moved.clawed_back, 0),
    'invites', (SELECT count(*) FROM public.referrals WHERE referrer_id = p_user)
  ) FROM earned, moved;
$$;

-- Moves the whole available reward into the spendable balance.
CREATE OR REPLACE FUNCTION public.transfer_referral_rewards(p_user uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  amount bigint;
  request text := 'referral-transfer-' || gen_random_uuid();
BEGIN
  PERFORM 1 FROM public.referral_accounts WHERE user_id = p_user AND NOT frozen FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Referral rewards are not available for this account'; END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_user AND status = 'active' AND NOT billing_hold FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Referral rewards are not available for this account'; END IF;
  amount := (public.referral_wallet(p_user)->>'available')::bigint;
  IF amount <= 0 THEN RETURN 0; END IF;
  INSERT INTO public.ledger(user_id, request_id, kind, credits, meta)
  VALUES (p_user, request, 'referral', amount,
    jsonb_build_object('source', 'referral_transfer', 'reason', 'Referral rewards transferred to balance'));
  INSERT INTO public.referral_wallet_moves(user_id, kind, source, credits, ledger_request_id)
  VALUES (p_user, 'transfer', 'wallet', amount, request);
  RETURN amount;
END;
$$;

-- Admin only (called from a server action that writes the audit row in the
-- same transaction). Records a cash payout that was sent outside the app.
CREATE OR REPLACE FUNCTION public.record_referral_cash_payout(
  p_user uuid, p_credits bigint, p_source text, p_cash_cents integer, p_currency text,
  p_method text, p_reference text, p_note text, p_actor uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  wallet jsonb;
  balance bigint;
  request text;
  payout public.referral_wallet_moves%ROWTYPE;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 OR p_source NOT IN ('wallet', 'balance')
     OR p_cash_cents IS NULL OR p_cash_cents < 0 OR COALESCE(btrim(p_method), '') = '' THEN
    RAISE EXCEPTION 'Invalid payout';
  END IF;
  PERFORM 1 FROM public.referral_accounts WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'This user has no referral rewards'; END IF;
  SELECT credits INTO balance FROM public.profiles WHERE id = p_user FOR UPDATE;
  wallet := public.referral_wallet(p_user);
  IF p_source = 'wallet' AND p_credits > (wallet->>'available')::bigint THEN
    RAISE EXCEPTION 'Payout exceeds the available rewards';
  END IF;
  IF p_source = 'balance' THEN
    IF p_credits > (wallet->>'reclaimable')::bigint THEN
      RAISE EXCEPTION 'Payout exceeds the referral credits transferred to the balance';
    END IF;
    IF p_credits > balance THEN RAISE EXCEPTION 'Payout exceeds the current balance'; END IF;
    request := 'referral-payout-' || gen_random_uuid();
    INSERT INTO public.ledger(user_id, request_id, kind, credits, meta)
    VALUES (p_user, request, 'referral', -p_credits,
      jsonb_build_object('source', 'referral_cash_payout', 'reason', 'Reward payout (processed by support)', 'actor_id', p_actor));
  END IF;
  INSERT INTO public.referral_wallet_moves(user_id, kind, source, credits, ledger_request_id, cash_cents,
    cash_currency, method, reference, note, actor_id)
  VALUES (p_user, 'cash_payout', p_source, p_credits, request, p_cash_cents, lower(COALESCE(NULLIF(btrim(p_currency), ''), 'usd')),
    btrim(p_method), NULLIF(btrim(p_reference), ''), NULLIF(btrim(p_note), ''), p_actor)
  RETURNING * INTO payout;
  RETURN to_jsonb(payout);
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_referral_account(uuid), public.claim_referral(uuid, text),
  public.apply_referral_order(public.billing_orders), public.billing_orders_referral_trigger(),
  public.referral_wallet(uuid), public.transfer_referral_rewards(uuid),
  public.record_referral_cash_payout(uuid, bigint, text, integer, text, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_referral_account(uuid), public.claim_referral(uuid, text),
  public.referral_wallet(uuid), public.transfer_referral_rewards(uuid),
  public.record_referral_cash_payout(uuid, bigint, text, integer, text, text, text, text, uuid)
  TO service_role;
NOTIFY pgrst, 'reload schema';
