-- Copyable API keys.
--
-- New keys also keep an AES-256-GCM copy of the plaintext, encrypted with the
-- server-only ENCRYPTION_KEY (the same scheme as provider_credentials), so the
-- owner can copy the key again from the dashboard. Authentication still uses
-- key_hash only. Keys created before this migration have no copy (NULLs) and
-- cannot be revealed; their owners create a replacement.
ALTER TABLE public.api_keys
  ADD COLUMN key_ciphertext bytea,
  ADD COLUMN key_iv bytea,
  ADD COLUMN key_auth_tag bytea,
  ADD CONSTRAINT api_keys_key_copy_complete CHECK (
    (key_ciphertext IS NULL) = (key_iv IS NULL)
    AND (key_iv IS NULL) = (key_auth_tag IS NULL)
  );
