-- Adds `openai_responses`: a channel that speaks OpenAI's Responses API
-- (`POST {base_url}/responses`) to a gateway chosen by base URL.
--
-- It is a distinct provider kind rather than a flag on 'openai_compatible'
-- because the two are different endpoints with different request bodies:
-- `/responses` takes `input` items, `/chat/completions` takes `messages`.
-- A gateway may serve one and not the other — kie.ai's `/codex/v1` is
-- Responses-only — so the endpoint cannot be inferred from the base URL.
--
-- Provider is the wire protocol on BOTH `channels` and `provider_credentials`,
-- and credentials are resolved by provider AND base URL. Storing the endpoint
-- kind here is therefore what stops a Responses key from being handed to a
-- chat-completions channel on the same host, and vice versa.
--
-- Only `channels` is constrained; `provider_credentials.provider` has no CHECK
-- and is validated in the application layer (lib/ai/providers.ts).
--
-- Widening a CHECK is backward compatible: every existing row already
-- satisfies the new predicate, so no data migration is needed.

ALTER TABLE "channels" DROP CONSTRAINT IF EXISTS "channels_provider_check";

ALTER TABLE "channels"
  ADD CONSTRAINT "channels_provider_check"
  CHECK (provider IN ('anthropic', 'anthropic_compatible', 'openai_compatible', 'openai_responses'));
