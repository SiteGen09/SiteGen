-- Adds `anthropic_compatible`: a channel that speaks Anthropic's Messages API
-- to a gateway chosen by base URL, rather than to Anthropic itself.
--
-- It is a distinct provider kind rather than a base URL allowed on
-- 'anthropic' because credentials are resolved by provider AND base URL. A
-- single 'anthropic' kind that sometimes honoured a base URL would let a relay
-- key match a channel pointed at api.anthropic.com, and vice versa.
--
-- 'anthropic' keeps its fixed endpoint and its ANTHROPIC_API_KEY fallback;
-- neither compatible kind has an env fallback, because neither has a
-- well-known key.
--
-- Widening a CHECK is backward compatible: every existing row already
-- satisfies the new predicate, so no data migration is needed.

ALTER TABLE "channels" DROP CONSTRAINT IF EXISTS "channels_provider_check";

ALTER TABLE "channels"
  ADD CONSTRAINT "channels_provider_check"
  CHECK (provider IN ('anthropic', 'anthropic_compatible', 'openai_compatible'));
