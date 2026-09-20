-- Move model pricing from code into the channels table.
--
-- PRICING in lib/ai/pricing.ts was a hardcoded constant keyed by model id, so
-- adding a model required a code change and a redeploy. Once callers choose
-- their own model that is untenable, so the rates live on the channel row.
--
-- Values are copied verbatim from the constant that was deleted. The channel's
-- credit_multiplier is applied on top of the computed USD cost
-- (creditsForUsage(cost, multiplier)), exactly as before, so these rates are
-- the base list price and existing channels keep charging what they charged.

ALTER TABLE "channels"
  ADD COLUMN "input_per_mtok" numeric(12, 6) NOT NULL DEFAULT 0,
  ADD COLUMN "output_per_mtok" numeric(12, 6) NOT NULL DEFAULT 0,
  ADD COLUMN "cached_per_mtok" numeric(12, 6) NOT NULL DEFAULT 0;

-- Backfill existing rows from the old constant, keyed by model id.
UPDATE "channels" SET
  input_per_mtok = CASE model_id
    WHEN 'claude-opus-4-20250514'   THEN 15
    WHEN 'claude-3-5-haiku-20241022' THEN 0.8
    WHEN 'stub-fixture'             THEN 0.5
    WHEN 'gemini-3-8-flash'         THEN 0.5
  END,
  output_per_mtok = CASE model_id
    WHEN 'claude-opus-4-20250514'   THEN 75
    WHEN 'claude-3-5-haiku-20241022' THEN 4
    WHEN 'stub-fixture'             THEN 2
    WHEN 'gemini-3-8-flash'         THEN 1.5
  END,
  cached_per_mtok = CASE model_id
    WHEN 'claude-opus-4-20250514'   THEN 1.5
    WHEN 'claude-3-5-haiku-20241022' THEN 0.08
    WHEN 'stub-fixture'             THEN 0.05
    WHEN 'gemini-3-8-flash'         THEN 0.05
  END
WHERE model_id IN (
  'claude-opus-4-20250514',
  'claude-3-5-haiku-20241022',
  'stub-fixture',
  'gemini-3-8-flash'
);

-- Drop the default now that every known row is priced: a new channel must
-- state its rates rather than silently inherit a zero charge.
ALTER TABLE "channels"
  ALTER COLUMN "input_per_mtok" DROP DEFAULT,
  ALTER COLUMN "output_per_mtok" DROP DEFAULT,
  ALTER COLUMN "cached_per_mtok" DROP DEFAULT;

ALTER TABLE "channels"
  ADD CONSTRAINT "channels_rates_nonnegative"
  CHECK (input_per_mtok >= 0 AND output_per_mtok >= 0 AND cached_per_mtok >= 0);