-- Per-key settings a consumer can edit after creating a key.
--
--   status            'disabled' pauses a key without revoking it; it can be
--                     re-enabled. 'revoked' stays permanent.
--   expires_at        NULL never expires.
--   quota_credits     spending limit in credits; NULL is unlimited.
--   used_credits      credits charged to requests made with this key, kept by
--                     the usage_events trigger below so every billed path
--                     (chat, media, site generation) counts without code.
--   allowed_models    public model ids the key may call; NULL allows all.
--   allowed_ips       IPs or CIDR ranges the key may be used from; NULL allows
--                     any. Parsed and normalised by the server action.
--   routing_provider_id / routing_sources
--                     overrides for this key only, layered over the owner's
--                     routing preferences. Same internal ids those tables use:
--                     a provider identity such as 'relay.fast', and a
--                     {"family:modality": "source_id"} object.
--
-- Writes go through server actions with the service role, as before.
ALTER TABLE public.api_keys DROP CONSTRAINT api_keys_status_check;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_status_check CHECK (status IN ('active', 'disabled', 'revoked')),
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN quota_credits bigint CHECK (quota_credits IS NULL OR quota_credits >= 0),
  ADD COLUMN used_credits bigint NOT NULL DEFAULT 0 CHECK (used_credits >= 0),
  ADD COLUMN allowed_models text[]
    CHECK (allowed_models IS NULL OR cardinality(allowed_models) BETWEEN 1 AND 500),
  ADD COLUMN allowed_ips text[]
    CHECK (allowed_ips IS NULL OR cardinality(allowed_ips) BETWEEN 1 AND 100),
  ADD COLUMN routing_provider_id text
    CHECK (routing_provider_id IS NULL OR char_length(routing_provider_id) BETWEEN 1 AND 255),
  ADD COLUMN routing_sources jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(routing_sources) = 'object');

-- Existing keys start from what they have already been charged, so a limit set
-- today counts the key's history rather than starting from zero.
UPDATE public.api_keys k
   SET used_credits = s.total
  FROM (SELECT api_key_id, sum(credits_charged) AS total
          FROM public.usage_events
         WHERE api_key_id IS NOT NULL AND credits_charged > 0
         GROUP BY api_key_id) s
 WHERE s.api_key_id = k.id;

-- usage_events is upserted (a media job's row is written once pending and
-- again when it settles), so the trigger adds only the change in charge.
CREATE FUNCTION public.track_api_key_usage()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  previous bigint := 0;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.api_key_id IS NOT NULL THEN
    previous := GREATEST(COALESCE(OLD.credits_charged, 0), 0);
    IF OLD.api_key_id IS DISTINCT FROM NEW.api_key_id THEN
      UPDATE public.api_keys SET used_credits = GREATEST(used_credits - previous, 0)
       WHERE id = OLD.api_key_id;
      previous := 0;
    END IF;
  END IF;
  IF NEW.api_key_id IS NOT NULL
     AND GREATEST(COALESCE(NEW.credits_charged, 0), 0) <> previous THEN
    UPDATE public.api_keys
       SET used_credits = GREATEST(used_credits + GREATEST(COALESCE(NEW.credits_charged, 0), 0) - previous, 0)
     WHERE id = NEW.api_key_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.track_api_key_usage() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER usage_events_track_api_key
AFTER INSERT OR UPDATE OF credits_charged, api_key_id ON public.usage_events
FOR EACH ROW EXECUTE FUNCTION public.track_api_key_usage();

NOTIFY pgrst, 'reload schema';
