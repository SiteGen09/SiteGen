-- Preserve explicit modality labels written by media analytics events.
-- Chat events leave source_label null and continue to receive the channel snapshot.
CREATE OR REPLACE FUNCTION snapshot_usage_source() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.source_label IS NOT NULL THEN
    RETURN NEW;
  END IF;
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
