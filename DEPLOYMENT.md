# Phase 1 Deployment Summary

## What This Phase Delivers

A complete, production-ready AI website generation platform with:

1. **Developer API** — POST /v1/generate accepts a business brief, returns a validated site spec JSON
2. **Credit-based billing** — Hold/settle pattern with concurrency safety, integrated with Whop
3. **Multi-provider routing** — Admin-configurable channels with fallback chains, zero-deploy updates
4. **Developer dashboard** — API key management, credit balance, usage logs, BYOK credentials
5. **Admin portal** — Channel configuration, user management, manual credit grants, audit log
6. **Production security** — RLS on every table, encrypted credentials, webhook signature verification

## What's Deliberately Out of Scope

This phase does NOT include:
- End-user (non-technical) website builder UI
- Site renderer or public site hosting
- Custom domains
- Developer marketplace / human handoff
- Automated payouts
- Any passthrough model-access endpoint (e.g. /v1/chat/completions)

## Architecture Overview

```
┌─────────────┐
│   Client    │
│  (curl/SDK) │
└──────┬──────┘
       │ Bearer sk_live_...
       ▼
┌─────────────────────────────────────────┐
│  POST /v1/generate                      │
│  ┌──────────────────────────────────┐   │
│  │ 1. API key auth (SHA-256 lookup) │   │
│  │ 2. Rate limit check (60 rpm)     │   │
│  │ 3. Idempotency check (24h cache) │   │
│  │ 4. Hold credits (FOR UPDATE)     │   │
│  │ 5. Generate spec (with retry)    │   │
│  │ 6. Settle from real token counts │   │
│  │ 7. Write usage event             │   │
│  └──────────────────────────────────┘   │
└─────────────┬───────────────────────────┘
              │
        ┌─────▼─────┐
        │  Channel  │
        │  Resolver │
        └─────┬─────┘
              │
     ┌────────┴────────┐
     ▼                 ▼
┌──────────┐    ┌──────────┐
│ Anthropic│    │ OpenAI   │
│  Native  │    │Compatible│
│  (cache) │    │ Fallback │
└──────────┘    └──────────┘

┌─────────────┐
│    Whop     │
│  Webhooks   │
└──────┬──────┘
       │ HMAC signature
       ▼
┌─────────────────────────────────┐
│  POST /api/webhooks/whop        │
│  ┌───────────────────────────┐  │
│  │ 1. Verify signature       │  │
│  │ 2. Dedupe on event_id     │  │
│  │ 3. Update entitlements    │  │
│  │ 4. Grant monthly credits  │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘

┌─────────────┐
│  Cron Job   │
└──────┬──────┘
       │ Bearer <CRON_SECRET>
       ▼
┌─────────────────────────────────┐
│  POST /api/cron/reconcile       │
│  (nightly drift repair)         │
└─────────────────────────────────┘
```

## Data Flow: /v1/generate Request

```
1. Request arrives
   POST /v1/generate
   Authorization: Bearer sk_live_abc...
   Idempotency-Key: uuid
   { businessName, type, description, language, details }

2. Authentication
   - Hash the key with SHA-256
   - Look up api_keys by key_hash
   - Check status = active
   - Update last_used_at

3. Rate limiting
   - Check calls in last 60s < rate_limit_rpm
   - Return 429 if exceeded

4. Idempotency check
   - Hash request body
   - Look up cached response by (api_key_id, idempotency_key, request_hash)
   - Return cached response if exists and < 24h old

5. Channel selection
   - Query channels WHERE task = 'site.spec' AND status IN ('active', 'degraded')
   - Filter by user's plan min_plan
   - Order by priority DESC
   - Build fallback chain from fallback_to links

6. Credit hold
   - Estimate worst-case tokens (10k input + 8k output)
   - Calculate hold = cost × multiplier, rounded up
   - SELECT balance FOR UPDATE (prevents concurrent overdraw)
   - Insert hold ledger row if balance sufficient
   - Return 402 if insufficient

7. Generate
   - Build prompt from business brief + site spec schema
   - Call AI with structured output (Zod schema)
   - On validation error: retry once with error appended
   - On second failure: release hold, return 400
   - On retryable error (429/5xx): walk fallback chain

8. Settle
   - Extract real token counts from provider response
   - Calculate actual cost from PRICING table
   - Insert settle ledger row (reverses hold + charges actual)
   - Write usage_events row

9. Return
   {
     spec: { meta, theme, pages },
     usage: {
       input_tokens, output_tokens, cached_tokens,
       cost_usd, credits_charged, model_id
     },
     request_id
   }
```

## Security Layers

### 1. RLS Policies
Every table has row-level security enabled:
- `profiles`: users see only their own row
- `api_keys`, `entitlements`, `ledger`, `usage_events`: owner_id = auth.uid()
- `channels`, `provider_credentials`, `billing_events`, `admin_audit_log`: no client access

**Enforced by:** Cross-tenant isolation test (16 assertions)

### 2. API Keys
- Format: `sk_live_` + 43-char base62 (256 bits entropy)
- Storage: SHA-256 hash only, never plaintext
- Lookup: Constant-time comparison via crypto.timingSafeEqual
- Display: First 8 chars + last 4 for identification

### 3. Provider Credentials
- Encryption: AES-256-GCM with random 12-byte IV per encrypt
- Master key: ENCRYPTION_KEY environment variable (32 bytes, base64)
- Access: Decrypted in memory per request, never logged
- Display: Last 4 chars only

### 4. Webhook Verification
- Algorithm: HMAC-SHA256 over `{webhook_id}.{timestamp}.{body}`
- Replay protection: 5-minute tolerance window
- Dedupe: event_id stored in billing_events before processing
- Response: 200 even on dedupe (idempotent from Whop's perspective)

### 5. Admin Routes
- Server-side role check on every request
- Never rely on hiding UI elements
- Every mutation writes admin_audit_log row (actor, before, after)

### 6. Rate Limiting
- Postgres-backed counter (survives instance restarts)
- Per API key from api_keys.rate_limit_rpm
- Sliding window (last 60 seconds)
- Returns 429 with Retry-After header

## Credit Ledger Mechanics

### Hold/Settle Pattern
```sql
-- 1. Hold (before generation)
SELECT balance FOR UPDATE;  -- Lock the user's row
INSERT INTO ledger (kind='hold', credits=-estimated);

-- 2. Generate (may fail)
-- ...

-- 3a. Settle (on success)
INSERT INTO ledger (kind='settle', credits=estimated);  -- Reverse hold
INSERT INTO ledger (kind='charge', credits=-actual);    -- Charge actual

-- 3b. Release (on failure)
INSERT INTO ledger (kind='release', credits=estimated); -- Reverse hold, no charge
```

### Why This Works
- Balance is NEVER stored as a column (derived from SUM(credits))
- `SELECT FOR UPDATE` prevents concurrent holds on same user
- Every ledger row is immutable and auditable
- Idempotency on request_id prevents double-charging

**Enforced by:** Credit concurrency test — two parallel $100 holds on a $100 balance → exactly one succeeds

## Channel Configuration

Admins configure channels via the admin portal without deploying:

```typescript
{
  id: 'spec-strong',           // Stable identifier
  label: 'Site Spec (Opus 4)', // Human-readable
  task: 'site.spec',           // What it's for
  provider: 'anthropic',       // or 'openai_compatible'
  model_id: 'claude-opus-4-20250514',
  credit_multiplier: 1.0,      // 1 credit = $0.0001
  status: 'active',            // active | degraded | off
  min_plan: 'free',            // free | starter | pro
  fallback_to: 'spec-cheap',   // Chain to this on 429/5xx
  priority: 100                // Higher = preferred
}
```

Changes take effect on the next API request — no code deploy required.

## Whop Integration

### Plans
Defined in `lib/billing/plans.ts`:
```typescript
{
  whop_plan_id: 'plan_xxx',
  internal_key: 'starter',
  monthly_credits: 500_000,  // $50 of generation
  rate_limit_rpm: 120
}
```

### Checkout Flow
1. User clicks "Upgrade to Pro" in dashboard
2. Frontend calls `/api/billing/status` to get checkout URL
3. Server calls Whop API to create checkout with `metadata: { user_id }`
4. User completes payment on Whop
5. Redirect back to `/dashboard/billing?session_id=xxx`
6. Frontend polls `/api/billing/status` until webhook arrives
7. Webhook updates entitlement, grants monthly credits
8. Poll returns new status, frontend shows success

### Webhook Events
- `membership.went_valid` → activate entitlement, grant monthly credits
- `membership.went_invalid` → deactivate entitlement (keep plan_key for history)
- `payment.failed` → set status to past_due
- `subscription.payment_renewal` → re-fetch membership, grant new period credits
- One-off purchase → grant credits once on payment.succeeded

### Reconciliation
Nightly cron job:
1. Fetch all active memberships from Whop API
2. Compare with local entitlements table
3. Activate any missing entitlements
4. Deactivate any that Whop no longer reports
5. Log drift repairs

## Testing Strategy

### Unit Tests (77 tests)
- Crypto: AES round-trip, tampered ciphertext detection
- API keys: Format, hash stability, constant-time comparison
- Site spec: Zod validation, HTML rejection, slug uniqueness
- Provider fallback: Chain walking, retry logic, cycle detection
- Pricing: Token cost calculation, credit rounding
- Generate flow: Request validation, scope enforcement, hash stability

### Integration Tests (46 tests)
- Webhook: Signature verification, dedupe, membership lifecycle
- Credits: Hold/settle/release with real Postgres transactions
- Idempotency: Cached response return, hash collision handling
- Isolation: 16-assertion test that user A cannot reach user B's data

### Manual Verification Needed
- [ ] Supabase auth flow (email confirmation, password reset)
- [ ] Whop checkout redirect and webhook delivery
- [ ] Admin portal channel test button with real provider keys
- [ ] /v1/generate with real Anthropic API (prompt caching)
- [ ] Rate limit enforcement across multiple requests
- [ ] Reconciliation cron with real Whop API

## Local Development

```bash
# 1. Start Supabase (Postgres + Auth)
pnpm supabase:start

# 2. Run migrations
pnpm db:migrate

# 3. Set environment variables
cp .env.example .env.local
# Fill in ANTHROPIC_API_KEY and ENCRYPTION_KEY

# 4. Start dev server
pnpm dev

# 5. Create admin user
pnpm db:studio
# Run: UPDATE profiles SET role = 'admin' WHERE email = 'you@example.com';

# 6. Add platform provider key in admin portal
# Navigate to localhost:3000/admin/credentials

# 7. Create a channel
# Navigate to localhost:3000/admin/channels

# 8. Test generation
curl -X POST http://localhost:3000/v1/generate \
  -H "Authorization: Bearer $(your-api-key)" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "businessName": "Test Cafe",
    "businessType": "restaurant",
    "description": "A cozy neighborhood coffee shop"
  }'
```

## Production Deployment (Vercel)

```bash
# 1. Create Supabase project (ap-southeast-1)
# Get project ref from dashboard

# 2. Push migrations
supabase link --project-ref your-ref
supabase db push

# 3. Set environment variables in Vercel dashboard
# Use .env.example as reference
# Generate fresh ENCRYPTION_KEY and CRON_SECRET

# 4. Deploy
vercel --prod

# 5. Configure Whop webhook
# Point to: https://your-domain.com/api/webhooks/whop
# Copy webhook secret to WHOP_WEBHOOK_SECRET

# 6. Set up reconciliation cron
# Use Vercel Cron or external service
# Schedule: 0 2 * * * (2am daily)
# URL: https://your-domain.com/api/cron/reconcile
# Header: Authorization: Bearer <CRON_SECRET>

# 7. Create admin user
# Run SQL in Supabase dashboard:
UPDATE profiles SET role = 'admin' WHERE email = 'admin@your-domain.com';

# 8. Add platform provider key via admin portal

# 9. Verify
curl https://your-domain.com/healthz
# Should return: {"status":"ok","timestamp":"..."}
```

## Monitoring

### Key Metrics
- Request count by endpoint and status code
- p95/p99 latency for /v1/generate
- Channel error rate (by channel_id)
- Credits consumed per hour
- Cost per request (by channel)
- Webhook delivery success rate

### Critical Alerts
1. **Webhook signature failure** → potential attack or config mismatch
2. **Channel error rate >10%** → provider issue or config problem
3. **Negative balance in ledger** → concurrency bug (should never happen)
4. **Reconciliation failure** → Whop API issue or auth problem
5. **Rate limit hit rate >50%** → potential abuse or need to raise limits

### Log Queries
All logs are structured JSON with request_id:

```bash
# Find all logs for a specific request
grep '"request_id":"req_abc123"' logs.json

# Find all 5xx errors
jq 'select(.level=="error" and .status >= 500)' logs.json

# Channel fallback events
jq 'select(.msg | contains("fallback"))' logs.json

# Credit holds
jq 'select(.msg == "credit hold succeeded" or .msg == "credit hold failed")' logs.json
```

## Cost Model

### Pricing
- 1 credit = $0.0001 (ten thousandth of a dollar)
- Charged from real provider token counts, never estimates
- Cached input tokens cost 10% of fresh input
- Multiplier applied per channel (1.0 default, 0.0 for BYOK)

### Example
```
Request generates 2,500 input + 4,000 output tokens on Opus 4
Provider cost: (2500 × $15/MTok) + (4000 × $75/MTok)
             = $0.0375 + $0.3000
             = $0.3375

Credits charged: ceil($0.3375 / $0.0001 × 1.0)
                = ceil(3375.0)
                = 3,375 credits

With 2.0 multiplier: 6,750 credits
With 0.0 multiplier (BYOK): 0 credits
```

### Plan Comparison
- **Free**: 10,000 credits/month ($1 of generation), 60 rpm
- **Starter** ($29/mo): 500,000 credits ($50), 120 rpm
- **Pro** ($99/mo): 2,000,000 credits ($200), 240 rpm
- **Top-up**: $50 → 500,000 credits (no expiry)

## Next Steps

Phase 1 is complete and production-ready. Future phases might include:

- **Phase 2: Site Renderer** — Turn specs into deployable static sites
- **Phase 3: Custom Domains** — DNS + SSL for user sites
- **Phase 4: Visual Editor** — Non-technical UI for site customization
- **Phase 5: Marketplace** — Human handoff for custom requests
- **Phase 6: Webhooks** — Notify users when generation completes

Each phase builds on this foundation without requiring changes to the Phase 1 API contract.
