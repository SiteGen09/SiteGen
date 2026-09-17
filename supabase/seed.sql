-- Local development seed: default serving channels.
-- Production channels are managed through the admin portal.

INSERT INTO channels (id, label, task, provider, model_id, credit_multiplier, status, min_plan, fallback_to, priority)
VALUES
  ('spec-cheap', 'Site Spec — Fast', 'site.spec', 'anthropic', 'claude-3-5-haiku-20241022', 1.0, 'active', 'free', NULL, 0),
  ('spec-strong', 'Site Spec — Quality', 'site.spec', 'anthropic', 'claude-opus-4-20250514', 1.2, 'active', 'starter', 'spec-cheap', 10),
  ('copy-cheap', 'Site Copy — Fast', 'site.copy', 'anthropic', 'claude-3-5-haiku-20241022', 1.0, 'active', 'free', NULL, 0),
  ('interview-cheap', 'Interview — Fast', 'interview', 'anthropic', 'claude-3-5-haiku-20241022', 1.0, 'active', 'free', NULL, 0),
  ('spec-byok', 'Site Spec — BYOK', 'site.spec', 'anthropic', 'claude-opus-4-20250514', 0, 'active', 'free', NULL, 0)
ON CONFLICT (id) DO NOTHING;
