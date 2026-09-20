# Routing follow-up verification

Captured on 2026-09-20 in E:/sitegen against local Supabase. `--run` invokes the
requested test suite once instead of leaving Vitest in watch mode. Exit codes
are recorded separately from each command’s output (trailing whitespace removed). No remote writes.

## First migration application

The first `pnpm db:migrate` exited 0 with these migration lines (the preceding
Supabase history-table notices also appear in the full rerun output below):

```text
$ tsx lib/db/migrate.ts
Running migrations...
Applying 20260920000600_widen_source_families.sql...
Migrations complete
```

## Type check

Command: `pnpm typecheck`
Exit code: 0

```text
$ tsc --noEmit
```

## Lint

Command: `pnpm lint`
Exit code: 0

```text
$ eslint . --max-warnings 0
```

## Full test suite

Command: `pnpm test --run`
Exit code: 0

```text
$ vitest "--run"
(!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, which is planned to become the default in a future major version of Vite:
  - ESM syntax in a file loaded as CommonJS (vitest.config.ts:1:1). Use a `.mjs` extension or set `"type": "module"` in the closest package.json
Set `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` to suppress this warning.

 RUN  v5.0.1 E:/sitegen


 Test Files  28 passed (28)
      Tests  327 passed (327)
   Start at  22:59:47
   Duration  23.73s (tests 43%, import 40%, transform 12%, setup 3%, worker 2%)

    Isolate  28 workers spawned · ~2.08s startup each (spawn + environment, per file)
             at least ~3.22s faster with isolate: false — reuses workers across files instead of one per file
```

## Migration rerun

Command: `pnpm db:migrate`
Exit code: 0

```text
$ tsx lib/db/migrate.ts
Running migrations...
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P06',
  message: 'schema "supabase_migrations" already exists, skipping',
  file: 'schemacmds.c',
  line: '132',
  routine: 'CreateSchemaCommand'
}
{
  severity_local: 'NOTICE',
  severity: 'NOTICE',
  code: '42P07',
  message: 'relation "schema_migrations" already exists, skipping',
  file: 'parse_utilcmd.c',
  line: '207',
  routine: 'transformCreateStmt'
}
Migrations complete
```

## Database uniqueness proof

Command: `Direct duplicate insert in a rollback transaction`
Exit code: 0

```text
CREATE UNIQUE INDEX channels_source_public_model_key ON public.channels USING btree (source_id, public_model_id) WHERE ((public_model_id IS NOT NULL) AND (source_id IS NOT NULL))
SQLSTATE 23505: duplicate key value violates unique constraint "channels_source_public_model_key"
Key (source_id, public_model_id)=(legacy-chat-stub, stub-chat) already exists.
Duplicate insert rolled back; no fixture remained.
```

## Admin-action and family integration proof

Command: `pnpm test --run tests/source-admin.test.ts --reporter=verbose`
Exit code: 0

```text
$ vitest "--run" "tests/source-admin.test.ts" "--reporter=verbose"
(!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, which is planned to become the default in a future major version of Vite:
  - ESM syntax in a file loaded as CommonJS (vitest.config.ts:1:1). Use a `.mjs` extension or set `"type": "module"` in the closest package.json
Set `VITE_CONFIG_NATIVE_IGNORE_WARNING=true` to suppress this warning.

 RUN  v5.0.1 E:/sitegen

stdout | tests/source-admin.test.ts
◇ injected env (15) from .env.local // tip: ⌘ multiple files { path: ['.env.local', '.env'] }

 ✓ tests/source-admin.test.ts > source repricing transaction > rejects absent confirmation and stale price or channel count without an audit or mutation 113ms
 ✓ tests/source-admin.test.ts > source repricing transaction > rolls back a price change if its audit cannot be written 31ms
 ✓ tests/source-admin.test.ts > source repricing transaction > commits a confirmed change with its before/after audit 32ms
 ✓ tests/source-admin.test.ts > source repricing transaction > keeps a usage source snapshot across source edits and idempotent retries 41ms
 ✓ tests/source-admin.test.ts > one public model per source > rejects a duplicate in PostgreSQL even when the write bypasses admin validation 14ms
 ✓ tests/source-admin.test.ts > one public model per source > returns a readable duplicate-create error and writes neither a channel nor an audit 43ms
 ✓ tests/source-admin.test.ts > one public model per source > allows the same name on another source and permits an unchanged edit 61ms
 ✓ tests/source-admin.test.ts > one public model per source > rejects reassigning a model onto a source that already serves it, without altering its audit 22ms
 ✓ tests/source-admin.test.ts > one public model per source > allows multiple internal channels with no public name on a source 40ms
 ✓ tests/source-admin.test.ts > one public model per source > keeps BYOK channels with no source outside the uniqueness guard 31ms
 ✓ tests/source-admin.test.ts > additional routing families > creates and selects a deepseek source through the existing actions and routing pipeline 267ms
 ✓ tests/source-admin.test.ts > additional routing families > creates and selects a qwen source through the existing actions and routing pipeline 220ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
   Start at  23:02:34
   Duration  4.80s (tests 46%, import 42%, transform 10%, setup 1%, worker 1%)
```

## Production build

Command: `pnpm build`
Exit code: 0

```text
$ next build
▲ Next.js 16.3.5 (Turbopack)
- Environments: .env.local
✓ Running next.config.ts took 169ms

⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.

  To migrate automatically, run:
  npx @next/codemod@canary middleware-to-proxy .

  Learn more: https://nextjs.org/docs/messages/middleware-to-proxy
  Creating an optimized production build ...
✓ Compiled successfully in 5.9s
  Running TypeScript ...
  Finished TypeScript in 13.2s ...
  Collecting page data using 11 workers ...
  Generating static pages using 11 workers (0/27) ...
  Generating static pages using 11 workers (6/27)
  Generating static pages using 11 workers (13/27)
  Generating static pages using 11 workers (20/27)
✓ Generating static pages using 11 workers (27/27) in 1675ms
  Finalizing page optimization ...

Route (app)
┌ ○ /
├ ○ /_not-found
├ ƒ /admin
├ ƒ /admin/audit
├ ƒ /admin/channels
├ ƒ /admin/credentials
├ ƒ /admin/sources
├ ƒ /admin/users
├ ƒ /api/admin/channels/test
├ ƒ /api/billing/status
├ ƒ /api/chat
├ ƒ /api/cron/probe-models
├ ƒ /api/cron/reconcile
├ ƒ /api/webhooks/whop
├ ƒ /auth/callback
├ ƒ /dashboard
├ ƒ /dashboard/billing
├ ƒ /dashboard/chat
├ ƒ /dashboard/credentials
├ ƒ /dashboard/keys
├ ƒ /dashboard/models
├ ƒ /dashboard/routing
├ ƒ /dashboard/status
├ ƒ /dashboard/usage
├ ○ /docs
├ ƒ /healthz
├ ƒ /login
├ ƒ /prices
├ ○ /signup
├ ƒ /v1/chat/completions
├ ƒ /v1/generate
├ ƒ /v1/models
└ ƒ /v1/responses


ƒ Proxy (Middleware)

○  (Static)   prerendered as static content
ƒ  (Dynamic)  server-rendered on demand
```

## Classifier output

Called the exported `classifyObservedHealth` function directly, without mocks.
The explicit no-success/all-probes-failed rule returns outage and error rate 1.

| Case | Health | Weighted error rate |
| --- | --- | --- |
| 1 good probe, no traffic | operational | 0.00% |
| 1 failed probe, no traffic | outage | 100.00% |
| 5 real requests all OK + 1 failed probe | operational | 6.67% |
| 20 real requests, 2 failed, no probe | degraded | 10.00% |
| 20 real requests all OK + 1 failed probe | operational | 3.33% |
| All 3 probes failed, no traffic | outage | 100.00% |
| 5 real requests, 1 failed + 1 failed probe | degraded | 13.33% |

## Rendered family options

Authenticated HTTP checks against the development app confirmed the actual
rendered form options and routing selectors (not just the family constant):

```text
PASS /admin/sources renders deepseek
PASS /admin/sources renders qwen
PASS /dashboard/routing renders deepseek
PASS /dashboard/routing renders qwen
```

## Scope and migration notes

The initial bootstrap migration was extended because its family guard executes
before migration 006 on fresh databases. Existing databases receive only the
new widening migration; they do not replay the backfill. Unknown names still
raise an explicit error. Migration regression tests execute the shipped SQL in
temporary relations and verify preserved prices, unknown-family rejection and
readable duplicate diagnostics including disabled channels.

The duplicate admin tests assert the full readable create/edit message, ensure
failed attempts leave no channel or audit mutation, allow another source to use
the same name, and preserve null-name and source-free BYOK cases. Both new
families are exercised through audited source/channel actions, authenticated
preference RLS and real channel selection. Test fixtures are cleaned up.

Billing, credit holds/settlement, the preference cascade and the usage-source
snapshot trigger were not changed. The existing Vite config-loader advisory
and Next middleware deprecation remain visible in the captured output; lint
exits successfully with zero warnings. Client-bundle scan: clean.
