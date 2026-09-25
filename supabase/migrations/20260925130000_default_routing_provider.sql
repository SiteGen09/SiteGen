-- The routing provider Auto starts with, whatever each source's own Default
-- flag says. At most one provider is the default; with none, Auto falls back
-- to the per-source defaults exactly as before.
ALTER TABLE public.routing_providers
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX routing_providers_one_default
  ON public.routing_providers ((true)) WHERE is_default;

-- Provider A (relay.fast) is the default until an administrator picks another.
INSERT INTO public.routing_providers (id, is_default)
VALUES ('relay.fast', true)
ON CONFLICT (id) DO UPDATE SET is_default = true, updated_at = now();

NOTIFY pgrst, 'reload schema';
