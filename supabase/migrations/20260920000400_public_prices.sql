-- Display vendor is neither the wire protocol nor the source's routing family.
ALTER TABLE channels
  ADD COLUMN vendor text,
  ADD COLUMN context_window integer CHECK (context_window > 0),
  ADD COLUMN endpoints text[] NOT NULL DEFAULT '{}',
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN pricing_type text NOT NULL DEFAULT 'token' CHECK (pricing_type IN ('token','request')),
  ADD COLUMN list_input_per_mtok numeric(12,6) CHECK (list_input_per_mtok >= 0),
  ADD COLUMN list_output_per_mtok numeric(12,6) CHECK (list_output_per_mtok >= 0),
  ADD COLUMN list_cached_per_mtok numeric(12,6) CHECK (list_cached_per_mtok >= 0);
-- Unknown vendor/context/list prices stay unknown. Guessing discounts would
-- publish fabricated savings, so administrators fill in verified metadata.
