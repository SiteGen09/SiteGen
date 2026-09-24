-- Provider-wide settings for upstream routing providers. `id` is the internal
-- identity from lib/ai/routing-provider.ts (for example 'kie.ai'); the public
-- id shown to consumers never changes, so a rename keeps links and filters.
--
--   label              public display name; NULL keeps the built-in alias.
--   credit_multiplier  provider-wide markup; NULL lets each source keep its own.
--
-- A set multiplier is enforced on every source write, so a catalog importer that
-- upserts its own hard-coded multiplier cannot undo an administrator's price,
-- and sources added to the provider later start at the provider's price.
CREATE TABLE public.routing_providers (
  id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 255),
  label text CHECK (label IS NULL OR (char_length(label) BETWEEN 1 AND 60 AND label = btrim(label))),
  credit_multiplier numeric(10,2) CHECK (credit_multiplier IS NULL OR credit_multiplier > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.routing_providers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.routing_providers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.routing_providers TO service_role;

-- Mirrors routingProviderIdentity() in lib/ai/routing-provider.ts: a channel's
-- endpoint host decides its provider, and the anonymous upstreams also match
-- their subdomains.
CREATE FUNCTION public.routing_provider_host(base_url text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN host IS NULL OR host = '' THEN NULL
    WHEN host = 'kie.ai' OR host LIKE '%.kie.ai' THEN 'kie.ai'
    WHEN host = 'relay.fast' OR host LIKE '%.relay.fast' THEN 'relay.fast'
    ELSE host
  END
  FROM (SELECT regexp_replace(
    lower(substring(base_url FROM '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/:?#]+)')),
    '^www\.', '') AS host) parsed;
$$;
REVOKE ALL ON FUNCTION public.routing_provider_host(text) FROM PUBLIC, anon, authenticated;

-- The provider serving most of a source's platform channels. A source with no
-- channel yet (an importer inserts the source first) falls back to the naming
-- convention the importers use, exactly as the TypeScript identity does.
CREATE FUNCTION public.source_routing_provider(source_id text, source_label text)
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT COALESCE(
    (SELECT public.routing_provider_host(c.base_url)
       FROM public.channels c
      WHERE c.source_id = source_routing_provider.source_id
        AND NOT c.is_byok
        AND public.routing_provider_host(c.base_url) IS NOT NULL
      GROUP BY 1
      ORDER BY count(*) DESC, 1
      LIMIT 1),
    CASE
      WHEN source_label ~* '^relay\.fast(\s|$)' OR source_routing_provider.source_id LIKE 'relay-%' THEN 'relay.fast'
      WHEN source_label ~* '^kie\.ai(\s|$)' OR source_routing_provider.source_id LIKE 'kie-%' THEN 'kie.ai'
    END);
$$;
REVOKE ALL ON FUNCTION public.source_routing_provider(text, text) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.apply_routing_provider_multiplier()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  managed numeric;
BEGIN
  SELECT p.credit_multiplier INTO managed
    FROM public.routing_providers p
   WHERE p.id = public.source_routing_provider(NEW.id, NEW.label)
     AND p.credit_multiplier IS NOT NULL;
  IF managed IS NOT NULL THEN
    NEW.credit_multiplier := managed;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_routing_provider_multiplier() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER sources_apply_provider_multiplier BEFORE INSERT OR UPDATE ON public.sources
FOR EACH ROW EXECUTE FUNCTION public.apply_routing_provider_multiplier();

-- A channel can be what places a source under a provider (a source with no
-- naming convention gets its provider from its first channel). Re-save the
-- source so the trigger above applies the provider's price at once; skip the
-- write when the price already matches, which is every catalog re-import.
CREATE FUNCTION public.apply_routing_provider_multiplier_from_channel()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  source_row public.sources%ROWTYPE;
  managed numeric;
BEGIN
  IF NEW.source_id IS NULL OR NEW.is_byok THEN
    RETURN NEW;
  END IF;
  SELECT * INTO source_row FROM public.sources WHERE id = NEW.source_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;
  SELECT p.credit_multiplier INTO managed
    FROM public.routing_providers p
   WHERE p.id = public.source_routing_provider(source_row.id, source_row.label)
     AND p.credit_multiplier IS NOT NULL;
  IF managed IS NOT NULL AND managed IS DISTINCT FROM source_row.credit_multiplier THEN
    UPDATE public.sources SET credit_multiplier = managed, updated_at = now() WHERE id = source_row.id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.apply_routing_provider_multiplier_from_channel() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER channels_apply_provider_multiplier
AFTER INSERT OR UPDATE OF source_id, base_url, is_byok ON public.channels
FOR EACH ROW EXECUTE FUNCTION public.apply_routing_provider_multiplier_from_channel();

NOTIFY pgrst, 'reload schema';
