-- Private serving metadata for admin analytics. Keep upstream model IDs out of
-- usage_events, whose own rows are readable by authenticated consumers.
CREATE TABLE usage_route_snapshots (
  request_id text PRIMARY KEY REFERENCES usage_events(request_id) ON DELETE CASCADE,
  model_id text NOT NULL,
  channel_label text NOT NULL,
  source_id text,
  source_label text,
  provider text NOT NULL,
  task text NOT NULL
);
ALTER TABLE usage_route_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON usage_route_snapshots FROM PUBLIC, anon, authenticated;
GRANT ALL ON usage_route_snapshots TO service_role;

CREATE FUNCTION snapshot_usage_route() RETURNS trigger
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
      c.source_id, CASE WHEN c.is_byok THEN 'BYOK' ELSE s.label END, c.provider, c.task
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
CREATE TRIGGER usage_route_snapshot AFTER INSERT OR UPDATE ON usage_events
  FOR EACH ROW EXECUTE FUNCTION snapshot_usage_route();

-- Do not backfill guessed metadata from today's catalog into historical rows.
COMMENT ON TABLE usage_route_snapshots IS
  'Admin-only model/channel/source labels captured when usage is recorded; legacy usage remains unsnapshotted.';
