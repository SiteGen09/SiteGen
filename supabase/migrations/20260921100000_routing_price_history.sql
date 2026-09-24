-- Provider imports and admin edits must leave the same price history. Keep
-- these snapshots separate from the private administrator audit trail.
CREATE TABLE public.routing_price_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('source.update', 'channel.update')),
  target text NOT NULL,
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.routing_price_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.routing_price_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.routing_price_history TO service_role;
CREATE INDEX routing_price_history_target_idx ON public.routing_price_history (target, id DESC);

CREATE FUNCTION public.routing_price_snapshot(row_value jsonb, source_row boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN source_row THEN
    jsonb_build_object('credit_multiplier', row_value->'credit_multiplier')
  ELSE jsonb_build_object(
    'pricing_type', row_value->'pricing_type',
    'request_price_usd', row_value->'request_price_usd',
    'input_per_mtok', row_value->'input_per_mtok',
    'output_per_mtok', row_value->'output_per_mtok',
    'cached_per_mtok', row_value->'cached_per_mtok',
    'billing_policy', row_value->'billing_policy'
  ) END;
$$;
REVOKE ALL ON FUNCTION public.routing_price_snapshot(jsonb, boolean) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.record_routing_price_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  source_row boolean := TG_TABLE_NAME = 'sources';
  old_price jsonb;
  new_price jsonb;
  old_comparison jsonb;
  new_comparison jsonb;
BEGIN
  IF NOT source_row THEN
    IF NEW.public_model_id IS NULL OR NEW.is_byok THEN
      RETURN NEW;
    END IF;
  END IF;
  old_price := public.routing_price_snapshot(to_jsonb(OLD), source_row);
  new_price := public.routing_price_snapshot(to_jsonb(NEW), source_row);
  old_comparison := old_price #- '{billing_policy,syncedAt}' #- '{billing_policy,version}';
  new_comparison := new_price #- '{billing_policy,syncedAt}' #- '{billing_policy,version}';
  IF old_comparison IS DISTINCT FROM new_comparison THEN
    INSERT INTO public.routing_price_history (action, target, before, after)
    VALUES (
      CASE WHEN source_row THEN 'source.update' ELSE 'channel.update' END,
      (CASE WHEN source_row THEN 'source:' ELSE 'channel:' END) || NEW.id,
      old_price, new_price
    );
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.record_routing_price_change() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER sources_record_price_change AFTER UPDATE ON public.sources
FOR EACH ROW EXECUTE FUNCTION public.record_routing_price_change();
CREATE TRIGGER channels_record_price_change AFTER UPDATE ON public.channels
FOR EACH ROW EXECUTE FUNCTION public.record_routing_price_change();

-- Preserve historical admin repricing where snapshots exist. Never invent
-- earlier prices for a catalog that was imported without history.
INSERT INTO public.routing_price_history (action, target, before, after, created_at)
SELECT a.action, a.target, p.old_price, p.new_price, a.created_at
FROM public.admin_audit_log a
CROSS JOIN LATERAL (SELECT
  public.routing_price_snapshot(a.before, a.action = 'source.update') AS old_price,
  public.routing_price_snapshot(a.after, a.action = 'source.update') AS new_price
) p
WHERE a.action IN ('source.update', 'channel.update')
  AND a.before IS NOT NULL AND a.after IS NOT NULL
  AND (a.action = 'source.update' OR
    (a.after->>'public_model_id' IS NOT NULL AND a.after->>'is_byok' = 'false'))
  AND (p.old_price #- '{billing_policy,syncedAt}' #- '{billing_policy,version}')
    IS DISTINCT FROM
    (p.new_price #- '{billing_policy,syncedAt}' #- '{billing_policy,version}')
ORDER BY a.id;

NOTIFY pgrst, 'reload schema';
