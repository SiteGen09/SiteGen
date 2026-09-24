-- Routing preferences are per family AND modality.
--
-- One vendor now serves chat, images and video, and those are separate
-- decisions. With a preference keyed on family alone, the GPT picker offered
-- "kie.ai chat", "kie.ai image" and "kie.ai video" as mutually exclusive
-- answers to one question, so choosing an image source silently repointed chat
-- at a gateway that serves no chat models at all.
--
-- `modality` on the source is what makes the pair meaningful, and it is
-- declared rather than derived from the source's channels: a source with no
-- channels yet still has to be pickable, and deriving it would make the
-- routing UI depend on catalogue state.

-- Media vendors join the family list. Family is model identity, so a Kling
-- model belongs to `kling` for the same reason a Gemini model belongs to
-- `gemini`. `other` is deliberate: the upstream catalogue labels some models
-- that way, and inventing a family per model would be worse than grouping
-- the unknowns honestly.
DO $$
DECLARE
  families text[] := ARRAY[
    'gpt','claude','grok','deepseek','qwen','gemini','zhipu','moonshot','minimax','tencent','xiaomi',
    'bytedance','kling','wan','runway','pixverse','ideogram','flux','topaz','elevenlabs','suno',
    'alibaba','other'
  ];
BEGIN
  EXECUTE 'ALTER TABLE sources DROP CONSTRAINT IF EXISTS sources_family_check';
  EXECUTE format(
    'ALTER TABLE sources ADD CONSTRAINT sources_family_check CHECK (family = ANY (%L))', families);
  EXECUTE 'ALTER TABLE user_routing_preferences DROP CONSTRAINT IF EXISTS user_routing_preferences_family_check';
  EXECUTE format(
    'ALTER TABLE user_routing_preferences ADD CONSTRAINT user_routing_preferences_family_check CHECK (family = ANY (%L))',
    families);
END $$;

-- Existing sources are all chat sources; that is what the catalogue held
-- before the media endpoints existed, so the default is correct for every
-- current row and no backfill is needed.
ALTER TABLE sources ADD COLUMN modality text NOT NULL DEFAULT 'chat'
  CHECK (modality IN ('chat', 'image', 'video'));

-- One default per family was already the rule; it now has to be one default
-- per family AND modality, or a chat default would suppress the image one.
DROP INDEX IF EXISTS sources_default_family_key;
CREATE UNIQUE INDEX sources_default_family_modality_key
  ON sources (family, modality) WHERE is_default;

-- Repoint the preference key. Existing rows are chat preferences, matching the
-- source default above, so the added column needs no interpretation.
ALTER TABLE user_routing_preferences ADD COLUMN modality text NOT NULL DEFAULT 'chat'
  CHECK (modality IN ('chat', 'image', 'video'));
ALTER TABLE user_routing_preferences DROP CONSTRAINT user_routing_preferences_pkey;
ALTER TABLE user_routing_preferences
  ADD CONSTRAINT user_routing_preferences_pkey PRIMARY KEY (user_id, family, modality);

-- The write policies re-check the source against the row. They must now match
-- modality as well: without it a browser could POST a video source against a
-- chat preference and bypass the picker entirely, which is the whole reason
-- these policies restate the rule instead of trusting the server action.
DROP POLICY IF EXISTS routing_insert ON user_routing_preferences;
DROP POLICY IF EXISTS routing_update ON user_routing_preferences;

CREATE POLICY routing_insert ON user_routing_preferences FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM sources s
    WHERE s.id = source_id
      AND s.family = user_routing_preferences.family
      AND s.modality = user_routing_preferences.modality
      AND s.status <> 'off'
      AND array_position(ARRAY['free','starter','pro'], s.min_plan) <=
          array_position(ARRAY['free','starter','pro'],
            coalesce((SELECT plan_key FROM entitlements WHERE user_id = auth.uid()), 'free'))
  ));

CREATE POLICY routing_update ON user_routing_preferences FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id AND EXISTS (
    SELECT 1 FROM sources s
    WHERE s.id = source_id
      AND s.family = user_routing_preferences.family
      AND s.modality = user_routing_preferences.modality
      AND s.status <> 'off'
      AND array_position(ARRAY['free','starter','pro'], s.min_plan) <=
          array_position(ARRAY['free','starter','pro'],
            coalesce((SELECT plan_key FROM entitlements WHERE user_id = auth.uid()), 'free'))
  ));
