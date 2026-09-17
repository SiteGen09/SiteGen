-- Add kie.ai Gemini channel
-- Run with: pnpm supabase db query -f scripts/add-kie-channel.sql

INSERT INTO channels (
  id, 
  label, 
  task, 
  provider, 
  base_url, 
  model_id, 
  credit_multiplier, 
  status, 
  priority
) VALUES (
  'spec-kie-gemini',
  'Kie.ai Gemini Flash',
  'site.spec',
  'openai_compatible',
  'https://api.kie.ai/gemini-3-8-flash-openai/v1',
  'gemini-3-8-flash',
  1.5,  -- 50% markup
  'active',
  40    -- Lower priority than stub (100), runs after stub fails
)
ON CONFLICT (id) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  status = EXCLUDED.status,
  priority = EXCLUDED.priority;

SELECT id, label, provider, base_url, model_id, credit_multiplier, status, priority 
FROM channels 
WHERE id = 'spec-kie-gemini';
