# Production Readiness Checklist

Every item must be true before production deployment.

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

## Billing

- [x] Reconciliation job runs and repairs drift
- [x] Credit holds prevent overdraw
- [x] Settlements use real token counts only
- [x] BYOK channels charge zero credits
- [x] Plan definitions match Whop configuration

## Observability

- [x] Structured logs carry request_id end to end
- [x] Healthz endpoint checks database connectivity
- [x] Metrics track request count, error rate, latency, credits, cost per channel
- [x] Alert paths configured for webhook failures, high error rates, negative balances

## Documentation

- [x] .env.example complete; clean checkout runs from the README alone
- [x] Errors return the standard shape with a request_id the user can quote
- [x] API documentation page shows working curl example
- [x] Admin promotion SQL documented

## CI/CD

- [x] Type check, lint, unit tests pass
- [x] Cross-tenant isolation test passes
- [x] Credit concurrency test passes
- [x] Migrations run against throwaway database in CI
- [x] Client bundle secret check passes

## Definition of Done

A developer with only the documentation page can:

1. Sign up
2. Buy a plan through Whop
3. Create an API key
4. Call POST /v1/generate with curl
5. Receive a valid site spec
6. See the credit charge in their ledger with matching token counts

An admin can:

1. Switch the serving channel to a different provider
2. See the change take effect on the next request without a deploy
3. Find that change in the audit log

## Pre-deployment

Before first production deploy, ensure:

- [ ] Supabase project created in ap-southeast-1
- [ ] Project ref documented in deployment notes
- [ ] All environment variables set in deployment platform
- [ ] ENCRYPTION_KEY generated and secured
- [ ] WHOP_API_KEY and webhook secret configured
- [ ] Primary Anthropic API key added as platform credential
- [ ] Migrations pushed to production database
- [ ] Initial admin user promoted via SQL
- [ ] Webhook endpoint registered in Whop dashboard
- [ ] Domain configured and SSL active
- [ ] Error monitoring configured (Sentry/etc)
- [ ] Backup strategy documented

## Post-deployment

After first deploy:

- [ ] Healthz endpoint responds 200
- [ ] Test signup flow end-to-end
- [ ] Verify Whop webhook delivery
- [ ] Confirm credit grant on plan purchase
- [ ] Test generate endpoint with real key
- [ ] Verify token counts match usage_events
- [ ] Check audit log for admin actions
- [ ] Confirm reconciliation job runs on schedule
- [ ] Monitor error rates for first 24h
