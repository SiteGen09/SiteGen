-- Relay bills each family at the source selected in the Relay account, which
-- can change at any time from the Relay dashboard. lib/ai/relay-sources.ts
-- reprices Relay chat channels from that selection and records its last sync
-- here; routing withholds those channels once the sync goes stale.
--
--   upstream_state      the selected sources and the ratios Relay last billed
--   upstream_synced_at  last successful sync; NULL means never synced
--   upstream_error      last failure, cleared by the next success
ALTER TABLE public.routing_providers
  ADD COLUMN upstream_state jsonb,
  ADD COLUMN upstream_synced_at timestamptz,
  ADD COLUMN upstream_error text CHECK (upstream_error IS NULL OR char_length(upstream_error) <= 500);

NOTIFY pgrst, 'reload schema';
