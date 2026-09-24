-- Production's sync_whop_purchase had been hand-edited to also grant credits
-- when p_meta->>'fulfillment' <> 'payment_succeeded_only', so subscriptions and
-- pre-2026-09-22 top-ups were credited by whichever paid-receipt event arrived
-- first, including a refund or dispute. The app, dispute repair and the Orders
-- page all assume credits are granted only on payment.succeeded, as defined in
-- 20260922010000_whop_fulfillment. This restores that definition verbatim so
-- every environment agrees. No Whop purchase existed in production when it was
-- applied (2026-09-24), so no account's credits change.
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
