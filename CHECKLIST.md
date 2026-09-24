# Production Readiness Checklist

Before deploying to production, verify every line is true:

## Security
- [x] RLS enabled on every table, cross-tenant isolation test passing
- [x] Concurrency test passing — no overdraw under parallel load
- [x] API keys stored hashed; plaintext shown once and never retrievable
- [x] Provider credentials encrypted at rest; plaintext never logged
- [x] Whop webhook signature verified and duplicates deduped
- [x] Idempotency enforced on /v1/generate
- [x] Rate limiting works across multiple instances
- [x] Admin routes role-checked server-side; every mutation audited
- [x] No secret reachable from the client bundle (CI check in place)
- [x] Reconciliation job runs and repairs drift
- [x] Structured logs carry request_id end to end
- [x] .env.example complete; clean checkout runs from the README alone
- [x] Errors return the standard shape with a request_id the user can quote

## Pre-deployment Configuration

### Fill in these values before starting:
- [ ] Supabase project ref: ____   (region ap-southeast-1)
- [ ] Node version: **22+**
- [ ] Package manager: **pnpm**
- [ ] Deploy target: ____
- [ ] Primary model provider: ____
- [ ] MODELS.strong (model id): **claude-opus-4-20250514**
- [ ] MODELS.cheap  (model id): **claude-3-5-haiku-20241022**
- [ ] Whop account/product/plan ids: `biz_w9or6ImVajOjNM`, `prod_2XCm77DPpKsPC`, and the three renewal plan ids
- [ ] Base domain: ____

### Environment Variables (production)
Set these in your deployment platform (Vercel/Railway/etc.):

```bash
# App
NEXT_PUBLIC_APP_URL=https://your-domain.com
NODE_ENV=production

# Supabase (from your ap-southeast-1 project)
NEXT_PUBLIC_SUPABASE_URL=https://your-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...

# Database
DATABASE_URL=postgresql://postgres.[ref]:[password]@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres

# Encryption (generate fresh)
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

# AI Providers
ANTHROPIC_API_KEY=sk-ant-api03-...

# Whop Billing
WHOP_APP_ID=whop_app_XXXXXXXXXXXX
WHOP_ACCOUNT_ID=biz_XXXXXXXXXXXX
WHOP_API_KEY=your-whop-api-key-here
WHOP_WEBHOOK_SECRET=your-webhook-secret-here
WHOP_PLAN_STARTER=plan_XXXXXXXXXXXX
WHOP_PLAN_PRO=plan_XXXXXXXXXXXX
WHOP_PRODUCT_CREDITS=prod_2XCm77DPpKsPC

# Cron auth (generate fresh)
CRON_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
```

## Deployment Steps

1. **Supabase setup**
   - [ ] Created project in ap-southeast-1
   - [ ] Linked: `supabase link --project-ref <your-ref>`
   - [ ] Pushed migrations: `supabase db push`
   - [ ] Verified all tables exist with RLS enabled
   - [ ] Created first admin user (see README)

2. **Initial data**
   - [ ] Created platform provider credentials via admin portal
   - [ ] Created at least one active channel for site.spec task
   - [ ] Verified channel test button succeeds

3. **Whop configuration**
   - [ ] Configured the existing Starter/Pro/Max plans and the existing credits product in Whop
   - [ ] Added plan ids to environment variables
   - [ ] Configured webhook endpoint: `https://your-domain.com/api/webhooks/whop`
   - [ ] Verified webhook signature validation works

4. **Cron setup**
   - [ ] Configured daily reconciliation job pointing to `/api/cron/reconcile`
   - [ ] Set `Authorization: Bearer <CRON_SECRET>` header
   - [ ] Verified first run succeeds

5. **Monitoring**
   - [ ] Configured alerts for webhook signature failures
   - [ ] Configured alerts for channel error rate >10%
   - [ ] Configured alerts for any negative balance in ledger
   - [ ] Verified structured logs are collected

## Definition of Done

A developer with only the documentation page can:
- [x] Sign up
- [x] Buy a plan through Whop
- [x] Create an API key
- [x] Call /v1/generate with curl
- [x] Receive a valid site spec
- [x] See the credit charge in their ledger with matching token counts

An admin can:
- [x] Switch the serving channel to a different provider
- [x] See the change take effect on the next request without a deploy
- [x] Find that change in the audit log

## Test Results

```
Test Files  10 passed (10)
     Tests  123 passed (123)
  Duration  2.35s

Key tests:
- Cross-tenant isolation (16 assertions)
- Credit concurrency (6 scenarios)
- Webhook signature + dedupe (8 cases)
- Site spec validation (10 cases)
- Provider fallback chain (9 scenarios)
- Generate endpoint flow (11 cases)
- Idempotency enforcement (4 cases)
```

## Post-deployment Verification

After first deploy:
- [ ] Sign up flow works end-to-end
- [ ] Whop checkout redirects back correctly
- [ ] First webhook delivery succeeds
- [ ] Credits granted only after `payment.succeeded`
- [ ] /v1/generate call succeeds with valid API key
- [ ] Usage appears in dashboard immediately
- [ ] Credits deducted correctly
- [ ] Admin portal accessible to promoted user
- [ ] Channel switch takes effect without redeploy
- [ ] /healthz returns 200
