-- Additive: existing channel pricing, credentials and defaults are untouched.
ALTER TABLE channels ADD COLUMN billing_policy jsonb;
ALTER TABLE channels ADD CONSTRAINT channels_billing_policy_object
  CHECK (billing_policy IS NULL OR jsonb_typeof(billing_policy) = 'object');
ALTER TABLE channels DROP CONSTRAINT channels_provider_check;
ALTER TABLE channels ADD CONSTRAINT channels_provider_check CHECK (provider IN
  ('anthropic','anthropic_compatible','openai_compatible','openai_responses','kie_jobs','openai_images'));
-- Persist completed synchronous image results for storage retry without regeneration.
ALTER TABLE media_jobs ADD COLUMN provider_result jsonb;
NOTIFY pgrst, 'reload schema';
