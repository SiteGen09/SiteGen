-- Usage is a historical bill. Reassigning or renaming a channel's source must
-- not retroactively change the source label shown beside a settled charge.
-- These are snapshots, deliberately without a source FK: retired sources can
-- be deleted without deleting the user's billing history. Older events remain
-- unknown because the channel's current assignment is not historical evidence.
ALTER TABLE usage_events ADD COLUMN source_id text, ADD COLUMN source_label text;

CREATE FUNCTION snapshot_usage_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.channel_id IS NOT DISTINCT FROM NEW.channel_id THEN
    NEW.source_id := OLD.source_id;
    NEW.source_label := OLD.source_label;
  ELSE
    SELECT c.source_id, CASE WHEN c.is_byok THEN 'BYOK' ELSE s.label END
      INTO NEW.source_id, NEW.source_label
      FROM channels c LEFT JOIN sources s ON s.id = c.source_id
      WHERE c.id = NEW.channel_id;
  END IF;
  RETURN NEW;
END;
$$;
-- The trigger covers both chat and the existing generation writers, including
-- retry upserts, without teaching the DB-agnostic fallback walker about sources.
CREATE TRIGGER usage_source_snapshot BEFORE INSERT OR UPDATE ON usage_events
  FOR EACH ROW EXECUTE FUNCTION snapshot_usage_source();
