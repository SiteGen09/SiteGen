-- Make channel_id nullable so moderation-rejected usage can be recorded
-- without requiring a real channel reference.

ALTER TABLE usage_events
  ALTER COLUMN channel_id DROP NOT NULL;

-- Drop the existing FK constraint
ALTER TABLE usage_events
  DROP CONSTRAINT usage_events_channel_id_fkey;

-- Re-add it with ON DELETE CASCADE to preserve cleanup behavior
ALTER TABLE usage_events
  ADD CONSTRAINT usage_events_channel_id_fkey
    FOREIGN KEY (channel_id)
    REFERENCES channels(id)
    ON DELETE CASCADE;

COMMENT ON COLUMN usage_events.channel_id IS 'Channel used for generation; null for moderation-rejected requests';
