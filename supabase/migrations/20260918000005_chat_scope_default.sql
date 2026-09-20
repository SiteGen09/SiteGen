-- Add the `chat` scope to the API-key default so keys can reach the gateway.
--
-- The site-spec `generate` scope is unchanged; this only widens the default
-- for newly created keys. Existing keys keep whatever scopes they hold, so an
-- operator grants `chat` explicitly to a key that predates the gateway.

ALTER TABLE "api_keys"
  ALTER COLUMN "scopes" SET DEFAULT '{"generate","chat"}';