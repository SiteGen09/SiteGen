# Relay.fast integration

Relay is an additional source. Its importer does not change any Kie channels,
credentials, fallback chains, source defaults, or existing user preferences.
New Relay channels have lower priority than existing channels. Select Relay.fast
under Dashboard → Routing, separately for each family and for chat or images.
The public Prices page includes a Source filter and expandable pricing details.

## Pricing

- Import the live catalog from https://relay.fast/api/pricing and verify its
  model names against the supplied key's https://relay.fast/v1/models response.
- Store actual Relay rates after its group ratio and model billing multiplier.
  Apply the existing platform markup of 1.5 once, through the source.
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
Prices are a versioned snapshot; rerun the importer to refresh them. No recurring
job is installed. Removed models are not silently deleted or disabled.

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
