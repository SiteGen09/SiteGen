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
  RETURN change;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_whop_purchase(text, uuid, bigint, bigint, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_whop_purchase(text, uuid, bigint, bigint, text, jsonb) TO service_role;

ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_min_plan_check;
ALTER TABLE sources ADD CONSTRAINT sources_min_plan_check CHECK (min_plan IN ('free','starter','pro','max'));
DROP POLICY IF EXISTS routing_insert ON user_routing_preferences;
DROP POLICY IF EXISTS routing_update ON user_routing_preferences;
CREATE POLICY routing_insert ON user_routing_preferences FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM sources s WHERE s.id = source_id
      AND s.family = user_routing_preferences.family AND s.modality = user_routing_preferences.modality
      AND s.status <> 'off'
      AND array_position(ARRAY['free','starter','pro','max'], s.min_plan) <=
          array_position(ARRAY['free','starter','pro','max'],
            coalesce((SELECT CASE WHEN status IN ('active','past_due') THEN plan_key ELSE 'free' END
              FROM entitlements WHERE user_id = auth.uid()), 'free'))
  ));
CREATE POLICY routing_update ON user_routing_preferences FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM sources s WHERE s.id = source_id
      AND s.family = user_routing_preferences.family AND s.modality = user_routing_preferences.modality
      AND s.status <> 'off'
      AND array_position(ARRAY['free','starter','pro','max'], s.min_plan) <=
          array_position(ARRAY['free','starter','pro','max'],
            coalesce((SELECT CASE WHEN status IN ('active','past_due') THEN plan_key ELSE 'free' END
              FROM entitlements WHERE user_id = auth.uid()), 'free'))
  ));
