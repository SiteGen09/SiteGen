-- A caller with their own provider key is served on a platform channel with
-- their credential swapped in, so the channel row says nothing about BYOK.
-- The settle path now writes source_label = 'BYOK' (and no source_id) on those
-- usage rows, and snapshot_usage_source already keeps an explicit label. The
-- route snapshot still copied the platform channel's source, which is what
-- admin monitoring reads first: BYOK calls showed under the platform source,
-- and revenue reporting would count the caller's own provider bill as ours.
-- Rows recorded before this change carry no marker and are left as they are.
CREATE OR REPLACE FUNCTION snapshot_usage_route() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Retry/upsert of the same outcome must not replace its historical labels.
  -- Legacy rows deliberately remain legacy when updated without rerouting.
  IF TG_OP = 'UPDATE' AND OLD.channel_id IS NOT DISTINCT FROM NEW.channel_id THEN
    RETURN NEW;
  END IF;

  IF NEW.channel_id IS NULL THEN
    DELETE FROM usage_route_snapshots WHERE request_id = NEW.request_id;
  ELSE
    INSERT INTO usage_route_snapshots
      (request_id, model_id, channel_label, source_id, source_label, provider, task)
    SELECT NEW.request_id, COALESCE(c.public_model_id, c.model_id), c.label,
      CASE WHEN NEW.source_label = 'BYOK' THEN NULL ELSE c.source_id END,
      CASE WHEN c.is_byok OR NEW.source_label = 'BYOK' THEN 'BYOK' ELSE s.label END,
      c.provider, c.task
    FROM channels c LEFT JOIN sources s ON s.id = c.source_id
    WHERE c.id = NEW.channel_id
    ON CONFLICT (request_id) DO UPDATE SET
      model_id = EXCLUDED.model_id, channel_label = EXCLUDED.channel_label,
      source_id = EXCLUDED.source_id, source_label = EXCLUDED.source_label,
      provider = EXCLUDED.provider, task = EXCLUDED.task;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION snapshot_usage_route() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION snapshot_usage_route() TO service_role;
