-- Routing family is model identity, not the upstream wire protocol. Widen both
-- checks together so DeepSeek and Qwen sources can also be selected by users.
-- Existing rows remain valid; this migration never reassigns or reprices them.
ALTER TABLE sources DROP CONSTRAINT sources_family_check;
ALTER TABLE sources ADD CONSTRAINT sources_family_check
  CHECK (family IN ('gpt', 'claude', 'grok', 'deepseek', 'qwen'));
ALTER TABLE user_routing_preferences DROP CONSTRAINT user_routing_preferences_family_check;
ALTER TABLE user_routing_preferences ADD CONSTRAINT user_routing_preferences_family_check
  CHECK (family IN ('gpt', 'claude', 'grok', 'deepseek', 'qwen'));

-- Several sources may serve a public model, but one source must have only one
-- route for it. Block writes between the diagnostic and index creation so a
-- concurrent assignment cannot turn a clear configuration error into a race.
LOCK TABLE channels IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  duplicate record;
BEGIN
  SELECT source_id, public_model_id, string_agg(id, ', ' ORDER BY id) AS channel_ids
    INTO duplicate
    FROM channels
    WHERE public_model_id IS NOT NULL AND source_id IS NOT NULL
    GROUP BY source_id, public_model_id
    HAVING count(*) > 1
    ORDER BY source_id, public_model_id
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Cannot create channels_source_public_model_key: source "%" has duplicate public model "%" on channels: %',
      duplicate.source_id, duplicate.public_model_id, duplicate.channel_ids
      USING HINT = 'Reassign or remove duplicate channel routes, then rerun this migration. Disabled channels also count.';
  END IF;
END $$;
CREATE UNIQUE INDEX channels_source_public_model_key
  ON channels (source_id, public_model_id)
  WHERE public_model_id IS NOT NULL AND source_id IS NOT NULL;
