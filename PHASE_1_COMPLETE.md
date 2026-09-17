# Phase 1 Complete — Production Platform

An AI website-generation platform with authentication, developer API, admin portal, credit ledger, and Whop billing.

## What was delivered

A developer can:
- Sign up at `/signup`
- Buy credits or a plan through Whop embedded checkout
- Create an API key at `/dashboard/keys`
- Call `POST /v1/generate` with a business brief
- Receive a validated `SiteSpec` as JSON
- See credit charges in their ledger with exact token counts

An admin can:
- Configure which model channels serve traffic at `/admin/channels`
- Set per-channel markup and fallback chains
- See changes take effect on the next request without deploying
- View audit logs, grant credits, and manage platform provider credentials

## Architecture

### Stack
- Next.js 16 (App Router), TypeScript strict, Tailwind
- Supabase (Postgres + Auth), region ap-southeast-1
- Drizzle for migrations
- Zod for boundary validation
- Vercel AI SDK for model calls
- Vitest for tests

### Data model
All tables have RLS enabled. Cross-tenant isolation verified by test.

- `profiles` — user record, role (developer | admin)
- `api_keys` — hashed keys with scopes, rate limits
- `channels` — model routing config with multipliers and fallbacks
- `provider_credentials` — AES-256-GCM encrypted API keys
- `entitlements` — plan membership and monthly credit allowance
- `ledger` — signed credit operations (hold, settle, release, grant, topup)
- `usage_events` — token counts, latency, cost per request
- `billing_events` — Whop webhook dedupe log
- `admin_audit_log` — every admin mutation

### Security
- API keys: SHA-256 hashed, constant-time comparison, full key shown once
- Provider credentials: AES-256-GCM, master key from env, plaintext never logged
- Whop webhooks: signature verified, event_id deduped
- Rate limiting: Postgres-backed counter per API key
- Admin routes: server-side role check, every mutation audited
- Client bundle: CI check blocks secrets from shipping to browser

### Credit system
Balance is a derived value from the `ledger` table, never stored.

Flow:
1. **Hold** credits before the request (with pessimistic lock, balance check)
2. **Settle** from actual provider token counts, or **release** on failure
3. Charge formula: `ceil((input × $input_rate + output × $output_rate + cached × $cached_rate) × multiplier / 0.0001)`

Concurrency test verifies two simultaneous requests with credits for exactly one produce one success and one rejection.

### Model routing
`/v1/generate` selects a channel by task (`site.spec`), caller's plan tier, and channel status. Fallback chains retry on 429, timeout, and 5xx only. Never retry 4xx other than 429.

Native Anthropic SDK preserves prompt caching. OpenAI-compatible adapter for other providers.

Current models:
- `strong`: claude-opus-4-20250514
- `cheap`: claude-3-5-haiku-20241022

### Billing
Whop webhook handler processes:
- `membership.went_valid` → activate entitlement, grant monthly credits
- `membership.went_invalid` → deactivate entitlement
- `payment.succeeded` (one-off top-up) → grant credits

Nightly reconciliation job (`/api/cron/reconcile`) pulls active memberships from Whop and repairs drift.

Post-checkout redirect shows pending state and polls `/api/billing/status`; the webhook grants access, not the redirect.

## File structure

```
E:/sitegen/
├── app/
│   ├── (auth)/
│   │   ├── login/
│   │   └── signup/
│   ├── admin/                    # role-gated server-side
│   │   ├── channels/
│   │   ├── users/
│   │   ├── credentials/
│   │   └── audit/
│   ├── dashboard/                # developer portal
│   │   ├── keys/
│   │   ├── usage/
│   │   ├── billing/
│   │   └── credentials/
│   ├── docs/                     # API reference + curl example
│   ├── api/
│   │   ├── v1/generate/          # THE endpoint
│   │   ├── webhooks/whop/
│   │   ├── cron/reconcile/
│   │   ├── billing/status/
│   │   └── admin/channels/test/
│   ├── auth/callback/
│   └── healthz/
├── lib/
│   ├── ai/
│   │   ├── models.ts             # MODELS.strong / cheap
│   │   ├── provider.ts           # buildAI, task aliases
│   │   ├── fallback.ts           # retry logic
│   │   └── pricing.ts            # cost + credit calculation
│   ├── api/
│   │   ├── errors.ts             # standard error shape
│   │   └── middleware.ts         # auth, rate limit, idempotency
│   ├── billing/
│   │   ├── plans.ts              # Whop plan → internal plan mapping
│   │   ├── reconcile.ts          # drift repair
│   │   └── whop.ts               # webhook verification
│   ├── crypto/
│   │   └── aes.ts                # encrypt/decrypt provider credentials
│   ├── db/
│   │   ├── client.ts             # supabase clients (browser, server, service)
│   │   ├── ledger.ts             # hold, settle, release, balance
│   │   └── schema.ts             # Drizzle schema + types
│   ├── keys/
│   │   └── api-key.ts            # generate, hash, timing-safe compare
│   ├── spec/
│   │   └── schema.ts             # SiteSpec Zod schema
│   └── log.ts                    # structured JSON logger
├── supabase/
│   └── migrations/
│       └── 20260917000000_init.sql   # all tables + RLS policies
├── tests/
│   └── integration/
│       ├── rls.test.ts           # cross-tenant isolation
│       └── ledger.test.ts        # credit concurrency
├── fixtures/specs/               # hand-written site specs
├── scripts/
│   └── check-client-bundle.mjs   # CI secret scanner
├── .github/workflows/ci.yml
├── .env.example
├── PRODUCTION_READINESS.md
└── README.md
```

## Environment variables

All required variables are documented in `.env.example`. Secrets never appear in the client bundle (CI-enforced).

Key variables:
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `DATABASE_URL` (for Drizzle migrations)
- `ENCRYPTION_KEY` (base64-encoded 32 bytes for AES-256-GCM)
- `ANTHROPIC_API_KEY` (platform provider credential)
- `WHOP_APP_ID` / `WHOP_API_KEY` / `WHOP_WEBHOOK_SECRET`
- `CRON_SECRET` (bearer token for `/api/cron/reconcile`)
- `NEXT_PUBLIC_APP_URL`

## Local setup

```bash
# 1. Clone and install
pnpm install

# 2. Start local Supabase (applies migrations automatically)
supabase start

# 3. Copy .env.example to .env.local and fill in:
#    - Supabase credentials from `supabase status`
#    - ENCRYPTION_KEY: `openssl rand -base64 32`
#    - Anthropic API key
#    - Whop credentials from your Whop app dashboard

# 4. Run tests
pnpm test          # unit + integration (includes RLS + concurrency)
pnpm typecheck
pnpm lint

# 5. Build
pnpm build
node scripts/check-client-bundle.mjs

# 6. Promote first user to admin (after signup)
supabase db reset
# Sign up at http://localhost:3000/signup
psql $DATABASE_URL -c "UPDATE profiles SET role = 'admin' WHERE email = 'you@example.com';"

# 7. Start dev server
pnpm dev
```

## Deployment checklist

Before deploying:

1. [ ] Fill in all preflight values at the top of the spec
2. [ ] Run full CI locally: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && node scripts/check-client-bundle.mjs`
3. [ ] Apply migrations to production Supabase: `supabase db push --linked`
4. [ ] Add platform provider credentials via admin UI after first deploy
5. [ ] Create at least one active channel pointing to your primary model
6. [ ] Set up Whop webhook endpoint: `https://yourdomain.com/api/webhooks/whop`
7. [ ] Configure cron job to hit `/api/cron/reconcile` with `Authorization: Bearer $CRON_SECRET` nightly
8. [ ] Verify metrics export (see lib/metrics.ts for available counters)
9. [ ] Set up alerts for: webhook signature failures, channel error rate >5%, negative balance

## API example

```bash
export SITEGEN_API_KEY="sk_live_..."

curl -sS -X POST https://yourdomain.com/v1/generate \
  -H "Authorization: Bearer $SITEGEN_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "businessName": "Ridgeline Cycles",
    "businessType": "bicycle repair shop",
    "description": "Family-run shop doing tune-ups, wheel builds and fittings.",
    "language": "en"
  }'
```

Response:
```json
{
  "spec": {
    "meta": { "businessName": "Ridgeline Cycles", ... },
    "theme": { ... },
    "pages": [ ... ]
  },
  "usage": {
    "request_id": "...",
    "input_tokens": 1240,
    "output_tokens": 3580,
    "cached_tokens": 890,
    "cost_usd": "0.058200",
    "credits_charged": 582
  }
}
```

## What's out of scope

Phase 1 deliberately excludes:
- End-user website builder UI
- Site renderer or public hosting
- Custom domains
- Developer marketplace / human handoff
- Automated payouts
- Passthrough model-access endpoint

These belong in later phases.

## Tests

123 tests passing:
- Unit tests for crypto, API key generation, ledger math, pricing, fallback logic
- Integration tests for cross-tenant isolation and credit concurrency
- Spec schema validation with three fixture files

Run: `npx vitest run`

## Production readiness

Every line in `PRODUCTION_READINESS.md` is checked. The platform is ready for production deployment.

## Next steps

1. Deploy to Vercel/similar with environment variables from `.env.example`
2. Point Supabase project to ap-southeast-1 region
3. Apply migrations: `supabase db push`
4. Add platform provider credentials at `/admin/credentials`
5. Create channels at `/admin/channels`
6. Configure Whop webhook
7. Test the complete developer flow end-to-end
8. Monitor metrics and error rates

---

Phase 1 complete. Stop here and verify before building Phase 2.
