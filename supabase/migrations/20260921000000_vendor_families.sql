-- Routing families now cover every vendor the price catalogue lists.
--
-- Family is model identity, never the wire protocol: a Gemini model reached
-- through an OpenAI-compatible relay is still `gemini`. Without these values a
-- channel for one of these vendors can be priced and listed but never routed,
-- because `channels_source_check` requires a source and a source needs a family.
--
-- Widening a CHECK is backward compatible; every existing row already
-- satisfies the new predicate, so no data migration is needed. Nothing is
-- reassigned or repriced here.

ALTER TABLE sources DROP CONSTRAINT sources_family_check;
ALTER TABLE sources ADD CONSTRAINT sources_family_check
  CHECK (family IN ('gpt', 'claude', 'grok', 'deepseek', 'qwen', 'gemini',
                    'zhipu', 'moonshot', 'minimax', 'tencent', 'xiaomi'));

ALTER TABLE user_routing_preferences DROP CONSTRAINT user_routing_preferences_family_check;
ALTER TABLE user_routing_preferences ADD CONSTRAINT user_routing_preferences_family_check
  CHECK (family IN ('gpt', 'claude', 'grok', 'deepseek', 'qwen', 'gemini',
                    'zhipu', 'moonshot', 'minimax', 'tencent', 'xiaomi'));
