-- Sources must exist before seeded channels.
INSERT INTO sources (id, family, label, credit_multiplier) VALUES
('legacy-spec-cheap', 'claude', 'spec-cheap', 1),
('legacy-spec-strong', 'claude', 'spec-strong', 1.2),
('legacy-copy-cheap', 'claude', 'copy-cheap', 1),
('legacy-interview-cheap', 'claude', 'interview-cheap', 1),
('legacy-spec-stub', 'gpt', 'spec-stub', 0.5),
('legacy-chat-stub', 'gpt', 'chat-stub', 1)
ON CONFLICT (id) DO NOTHING;

-- Local development seed: default serving channels.
-- Production channels are managed through the admin portal.
--
-- Rates are USD per million tokens and are the channel's base list price; each
-- channel's credit_multiplier is applied on top at billing time. The values
-- below are the ones the deleted PRICING constant carried, so seeded channels
-- charge exactly what they charged before pricing moved into the database.

INSERT INTO channels (
  id, source_id, is_byok, label, task, provider, model_id, credit_multiplier, status, min_plan,
  fallback_to, priority, input_per_mtok, output_per_mtok, cached_per_mtok
)
VALUES
  -- claude-3-5-haiku-20241022: 0.8 / 4 / 0.08
  ('spec-cheap', 'legacy-spec-cheap', false, 'Site Spec — Fast', 'site.spec', 'anthropic', 'claude-3-5-haiku-20241022', 1.0, 'active', 'free', NULL, 0, 0.8, 4, 0.08),
  -- claude-opus-4-20250514: 15 / 75 / 1.5
  ('spec-strong', 'legacy-spec-strong', false, 'Site Spec — Quality', 'site.spec', 'anthropic', 'claude-opus-4-20250514', 1.2, 'active', 'starter', 'spec-cheap', 10, 15, 75, 1.5),
  ('copy-cheap', 'legacy-copy-cheap', false, 'Site Copy — Fast', 'site.copy', 'anthropic', 'claude-3-5-haiku-20241022', 1.0, 'active', 'free', NULL, 0, 0.8, 4, 0.08),
  ('interview-cheap', 'legacy-interview-cheap', false, 'Interview — Fast', 'interview', 'anthropic', 'claude-3-5-haiku-20241022', 1.0, 'active', 'free', NULL, 0, 0.8, 4, 0.08),
  ('spec-byok', NULL, true, 'Site Spec — BYOK', 'site.spec', 'anthropic', 'claude-opus-4-20250514', 0, 'active', 'free', NULL, 0, 15, 75, 1.5)
ON CONFLICT (id) DO NOTHING;

-- Local stub channels, pointed at scripts/stub-provider.mjs (port 11435).
-- Kept in the seed so `supabase db reset` cannot silently break the local
-- gateway/E2E flow. They are harmless in a fresh dev DB: without the matching
-- platform credential (see scripts/seed-local-creds.mjs) they simply fail to
-- resolve a key. `stub-fixture`: 0.5 / 2 / 0.05.
INSERT INTO channels (
  id, source_id, is_byok, label, task, provider, base_url, model_id, public_model_id,
  credit_multiplier, status, min_plan, fallback_to, priority,
  input_per_mtok, output_per_mtok, cached_per_mtok
)
VALUES
  ('spec-stub', 'legacy-spec-stub', false, 'Site Spec — Stub', 'site.spec', 'openai_compatible', 'http://localhost:11435/v1', 'stub-fixture', NULL, 0.5, 'active', 'free', NULL, 100, 0.5, 2, 0.05),
  ('chat-stub', 'legacy-chat-stub', false, 'Gateway — Stub', 'chat.completions', 'openai_compatible', 'http://localhost:11435/v1', 'stub-fixture', 'stub-chat', 1.0, 'active', 'free', NULL, 0, 0.5, 2, 0.05)
ON CONFLICT (id) DO NOTHING;