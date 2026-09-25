-- A consumer's own default routing provider: Auto starts on it for every
-- family and modality it serves, ahead of the administrator's default.
-- `provider_id` is the internal identity (for example 'relay.fast'); pages
-- only ever show its anonymous public alias. A family-level choice in
-- user_routing_preferences still wins over this.
--
-- It only reorders channels the user is already eligible for, so it needs no
-- plan check. Writes go through the server action with the service role.
CREATE TABLE public.user_routing_provider (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider_id text NOT NULL CHECK (char_length(provider_id) BETWEEN 1 AND 255),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.user_routing_provider ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_routing_provider FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_routing_provider TO service_role;

NOTIFY pgrst, 'reload schema';
