-- Dashboard default: Gemini 3.5 Flash. Its retry chain uses the cheaper Kie
-- Flash models. Never turn disabled models on or alter other providers.
-- All candidates must be available to free users at both channel and source.
-- Among backups, rank the current marked-up input + output price, with stable
-- names breaking ties. The candidate list bounds the chain to four channels.
WITH candidates AS (
  SELECT c.id, c.public_model_id,
    (c.input_per_mtok + c.output_per_mtok) * s.credit_multiplier AS price,
    c.input_per_mtok * s.credit_multiplier AS input_price,
    c.output_per_mtok * s.credit_multiplier AS output_price
  FROM channels c JOIN sources s ON s.id = c.source_id
  WHERE c.id IN (
    'kie-chat-gemini-3-5-flash-openai',
    'kie-chat-gemini-3-6-flash-openai',
    'kie-chat-gemini-3-7-flash-openai',
    'kie-chat-gemini-3-8-flash-openai'
  )
    AND c.base_url = 'https://api.kie.ai/v1'
    AND c.provider = 'openai_compatible'
    AND c.task = 'chat.completions' AND c.pricing_type = 'token'
    AND c.is_byok = false AND c.status = 'active' AND s.status = 'active'
    AND s.modality = 'chat' AND c.min_plan = 'free' AND s.min_plan = 'free'
), affordable AS (
  SELECT c.* FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1 FROM candidates primary_model
    WHERE primary_model.public_model_id = 'gemini-3-5-flash-openai'
      AND (c.input_price > primary_model.input_price OR c.output_price > primary_model.output_price)
  )
), chain AS (
  SELECT id, lead(id) OVER (ORDER BY
    CASE WHEN public_model_id = 'gemini-3-5-flash-openai' THEN 0 ELSE 1 END,
    price, public_model_id
  ) AS next_id
  FROM affordable
)
UPDATE channels c SET fallback_to = chain.next_id
FROM chain WHERE c.id = chain.id;
