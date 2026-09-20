-- Addressable model names and a chat task for the OpenAI-compatible gateway.
--
-- `public_model_id` is the name a caller passes as `"model"`; `model_id` stays
-- the real upstream model string and is never exposed to callers.

ALTER TABLE "channels"
  ADD COLUMN "public_model_id" text;

-- Unique only over the non-null names: channels without a public name (every
-- site-spec channel) must not collide with each other on NULL.
CREATE UNIQUE INDEX "channels_public_model_id_key"
  ON "channels" ("public_model_id")
  WHERE "public_model_id" IS NOT NULL;

-- The gateway's task alias joins the existing ones.
ALTER TABLE "channels" DROP CONSTRAINT "channels_task_check";
ALTER TABLE "channels"
  ADD CONSTRAINT "channels_task_check"
  CHECK (task IN ('site.spec', 'site.copy', 'interview', 'chat.completions'));