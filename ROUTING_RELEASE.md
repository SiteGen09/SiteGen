# Routing, status, chat and public prices

Implemented on 2026-09-20. The BYOK refactor is isolated in `184df98`; source
migration and dispatch land together in `a389433`. The remaining implementation
adds the admin/dashboard surfaces, synthetic status probes, session chat and prices.

## Deployment requirements

**Hourly probes require a paid Vercel plan or an external hourly scheduler.
Vercel Hobby permits daily cron jobs only.** The scheduled endpoint is
`GET /api/cron/probe-models`, authenticated with `Authorization: Bearer <CRON_SECRET>`.
An external scheduler must send the same header. Probes consume small upstream
requests but do not debit user credits.

Apply the SQL migrations through `20260920000500_usage_source_snapshot.sql`
before starting the updated application. The runner loads `.env.local`, records
versions in Supabase's migration history and serializes concurrent migration
attempts; rerunning it is a no-op for applied versions. The previous runner
replayed all DDL and could not migrate the existing database safely.

Review family mappings before a production migration. Existing data has no
vendor family: known Claude/Grok/GPT model names are mapped explicitly by name;
the local stub belongs to GPT. Unknown names stop the migration with an error
requiring an explicit mapping. Wire protocol is never used to infer family.
No default sources are invented during backfill. Every existing non-BYOK
channel receives its own source with its exact previous multiplier.

## Behavior and data decisions

- Platform routing uses the user's eligible preferred source, then an eligible
  family default, then the existing priority/status/id order. Missing model
  coverage does not cause a 404. Cross-source availability fallbacks settle
  against the serving channel's rates. Source family and plan constraints are
  enforced by both the routing action and preference RLS.
- Source repricing requires confirmation of the previous multiplier and current
  assigned-channel count. A transaction lock shared with channel assignment
  prevents that count changing during the update. Every admin mutation and
  default-source change is audited in the same transaction.
- The old unique public-model index was incompatible with several sources
  serving one public name; it is now nonunique. The old channel multiplier is
  retained but unwritten. Its temporary BYOK check is superseded by the
  BYOK/source-nullability check, so new BYOK rows need no legacy multiplier write.
  Rollback after adding/reassigning channels requires a deliberate restoration
  of the legacy column and model uniqueness; the retained column is not an
  automatic rollback for new configuration.
- Usage records now snapshot their source label in the database. Subsequent
  source renames, channel reassignment and retry upserts do not relabel history.
  Events predating the snapshot migration show an unknown source rather than
  guessing from today's configuration. Null-channel moderation events render
  correctly. Dashboard clients receive public model names only.
- The 24 buckets include the current UTC hour and previous 23 hours. Usage and
  probes aggregate independently to avoid double-counting joins. One probe
  contributes ten observations to the existing minimum-sample classifier, so
  an unused but successfully probed model is green. No observations remain
  gray. Availability and observed SLA count operational observed model-hours;
  gray hours are excluded and degraded hours are not operational. This is an
  observed status statistic, not a contractual uptime guarantee.
- Chat uses verified Supabase sessions and the shared moderation, plan ceiling,
  hold and settlement pipeline. Usage has a null API-key ID. Conversation reads
  are owner-scoped by RLS; server-only writes prevent forged assistant turns.
  A bounded per-conversation lease prevents overlapping replies. The server
  continues consuming and settling after a browser disconnect within the
  hosting function's duration limit.
- Prices are public, server-rendered and filtered/sorted in the browser. Rates
  use the default source where it has coverage, otherwise the best source.
  Vendor prices are converted to credits before computing discounts. Missing
  vendor/context/list-price metadata stays unknown; no values are fabricated.

## Limits found in the existing gateway

The gateway implements token-based chat/responses and site generation. It has
no image-generation or Anthropic-native public endpoint. Endpoint metadata
links to documentation explaining supported routes. Request-priced entries
display the correct per-request units and are marked “Catalog only”; they are
excluded from token dispatch, fallback, chat selection and probes so a
per-request rate cannot be accidentally interpreted as a per-million-token rate.
Implementing additional endpoint protocols or request billing is separate work.

## Verification

- `pnpm supabase:start` and `pnpm db:migrate`: passed on local Supabase; applied
  versions are skipped on rerun.
- Backfill inspection: all six original platform channels retained exact
  multipliers: chat-stub/copy-cheap/interview-cheap/spec-cheap = 1,
  spec-strong = 1.2, spec-stub = 0.5. spec-byok has no source.
- `pnpm typecheck`: passed. `pnpm lint`: passed with zero warnings.
- `pnpm test --run`: 27 files, 304 tests passed. Includes preference cascade,
  status evidence, fragmented UTF-8 SSE, metadata, owner/family/plan isolation,
  stale repricing confirmation, audit-failure rollback and usage snapshots.
- `pnpm build`: passed. The existing middleware deprecation remains.
- `node scripts/check-client-bundle.mjs`: clean.
- `node --env-file=.env.local scripts/verify-routing-chat.mjs`: 24 assertions
  passed against the local gateway and stub provider. The preferred source
  charged 130 credits at ×2; missing coverage fell back to 65 credits at ×1.
  Repeated cron calls kept the same row count, populated status cells, and
  session chat produced SSE, persisted both turns and wrote null-key usage.
- Browser checks: source selection/save feedback, chat streaming and reload
  persistence, price search/empty state/reset, confirmed source repricing and
  reversal with audit records, and channel metadata save.

The proof used the local stub at port 11435 and the development app at port
3001. Real upstream credentials were not exercised. The local environment has
no moderation API key, so end-to-end moderation used the existing skip behavior;
the automated pipeline tests cover moderation behavior. Vitest prints an
existing Vite configuration-loader advisory; the suite still exits successfully.

The reusable proof script only accepts localhost targets, creates dedicated
test fixtures, revokes its temporary API key, and restores defaults even on
failure. It retains its named account/messages for browser inspection. After
this verification run, proof sources and their channel were disabled and the
temporary default was removed to restore normal local routing.
