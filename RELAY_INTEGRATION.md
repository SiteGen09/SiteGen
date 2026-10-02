# Relay.fast integration

Relay is an additional source. Its importer does not change any Kie channels,
credentials, fallback chains, source defaults, or existing user preferences.
New Relay channels have lower priority than existing channels. Select Relay.fast
under Dashboard → Routing, separately for each family and for chat or images.
The public Prices page includes a Source filter and expandable pricing details.

## Pricing

- Import the live catalog from https://relay.fast/api/pricing and verify its
  model names against the supplied key's https://relay.fast/v1/models response.
- Store actual Relay rates after its group ratio and model billing multiplier,
  rescaled to the account's selected source (see Source pricing). Apply the
  platform markup once, through the source.
- One platform credit is $0.0001. Completed requests round up to whole credits.
- Token billing includes uncached input, output, cache reads, and cache writes
  where reported by the upstream. Models without the new policy keep their
  existing billing behavior.
- Context tiers apply to the entire request using total input including cache
  reads. DeepSeek peak windows are 01:00–04:00 and 06:00–10:00 UTC, selected when
  the channel resolves. A call crossing a window boundary could differ from
  upstream accounting; the upstream does not return a billed tier in standard usage.
- Image jobs allow one image per request. gpt-image-2 has separate prices for
  dimensions above 1792 px. Other current image models use a flat request price.
- Cached tokens and time tiers use exact catalog values rather than rounded UI
  labels. Billing expressions are parsed as a restricted grammar, never evaluated.

## Source pricing

Relay bills each family at the source selected in the Relay account's Routing
page (GPT Team/Plus, Plus/Pro, Pro/Enterprise; Claude Kiro, Max, ...), times
the model's billing multiplier. The public catalog only publishes the default
source, which is not even the cheapest one for every family (Grok's default is
Grok Heavy). Switching source in the Relay dashboard therefore changes our cost
without any catalog change.

- The importer stores each chat model's catalog rates as `sourcePricing.baseTiers`
  with the ratio they were built at (`factor`). `tiers` are the base times `scale`.
- `lib/ai/relay-sources.ts` runs every minute inside the server (started from
  `instrumentation.ts`). It reads the selection from `GET /api/routing/profile`
  and what Relay actually billed from `GET /api/log/self`, and rewrites the rates
  of every Relay chat channel whose price moved. Price history records each change.
- The price is the higher of the listed source price and the ratio Relay last
  billed that model on the same source. Relay's listing and its billing have
  disagreed (a price change listed as effective days before billing followed),
  so this never charges less than Relay bills.
- Claude Max applies only to the request paths its profile lists; other paths
  stay on Kiro, as Relay does.
- The last sync is recorded on `routing_providers` (`relay.fast`):
  `upstream_synced_at`, `upstream_state`, `upstream_error`. If it is older than
  ten minutes, routing withholds every source-priced Relay chat channel and Auto
  falls back to other providers. A newly imported model is withheld until its
  first sync.
- Needs `RELAY_ACCESS_TOKEN` (a Relay system access token, not the `sk-` key)
  and `RELAY_USER_ID` (the Relay account id, sent as `New-Api-User`).
- Preview: `pnpm exec tsx scripts/sync-relay-sources.mts`; apply once:
  `--apply`. Check billing against Relay: `pnpm exec tsx scripts/reconcile-relay-costs.mts`.
- Image models are in Relay's fixed-price image family and are not rescaled.

## Installation and refreshing

1. Apply the `20260921000400_relay_billing` and `20260921000600_relay_image_finalize` migrations through the normal
   database migration process before deploying the updated application.
2. Set `RELAY_API_KEY` in the server environment, along with the existing
   `DATABASE_URL` and `ENCRYPTION_KEY`. Never use a NEXT_PUBLIC variable for it.
3. Preview: `pnpm exec tsx scripts/import-relay-catalog.mts`
4. Apply: `pnpm exec tsx scripts/import-relay-catalog.mts --apply`

The apply operation encrypts the platform credentials using the application's
existing AES-GCM mechanism. Repeated imports update Relay prices and metadata,
preserving administrator status/default/markup choices. Import is transactional
and checks that non-Relay configuration is unchanged. Unknown vendors, billing
expressions, and inaccessible models fail the import instead of guessing rates.
Prices are a versioned snapshot; rerun the importer to refresh them. A re-import
keeps each row's current source scale. Only the source sync runs on a schedule. Removed models are not silently deleted or disabled.

## Images

Relay uses OpenAI image generation rather than Kie's job protocol. The image
adapter runs after the HTTP response, with a 300-second route budget and a
240-second upstream timeout. It stores the returned image privately and settles
the existing credit hold. Failed generation releases the hold. Persisted results
can be copied to storage again by the existing media sweep without generating or
paying twice. Orphaned attempts expire after ten minutes. Deployment must support
Next's `after` lifecycle and the route duration; Kie's existing path is unchanged.

The local installation contains all 45 advertised models (41 chat, 4 images).
Live streaming and buffered chat were verified. During verification Relay returned
HTTP 503 `model_not_found` / no available upstream channel for gpt-image-2 and
gpt-image-2.5; both local holds were refunded. Successful image storage/settlement
and retry behavior are covered with mocked upstream results, not a live image.
