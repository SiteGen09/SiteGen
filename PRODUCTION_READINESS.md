# Production Readiness Checklist

Every line must be true before deploying Phase 1 to production.

## Security & Data Integrity

- [x] RLS enabled on every table
- [x] Cross-tenant isolation test passing (tests/integration/rls.test.ts)
- [x] Concurrency test passing — no overdraw under parallel load (tests/integration/ledger.test.ts)
- [x] API keys stored hashed; plaintext shown once and never retrievable
- [x] Provider credentials encrypted at rest; plaintext never logged
- [x] Whop webhook signature verified and duplicates deduped
- [x] Idempotency enforced on /v1/generate
- [x] Rate limiting works across multiple instances (Postgres-backed counter)
- [x] Admin routes role-checked server-side; every mutation audited
- [x] No secret reachable from the client bundle (CI check in place)

## Billing & Credits

- [x] Reconciliation job runs and repairs drift (app/api/cron/reconcile)
- [x] Credits charged from provider-returned token counts only, never estimates
- [x] Balance is a derived value; never stored as a column
- [x] Hold → settle / release flow prevents overdraw
- [x] Monthly credit grants triggered by Whop webhook, never by cron

## Observability

- [x] Structured logs carry request_id end to end
- [x] /healthz endpoint checks database connectivity
- [x] Metrics exposed: request count, error rate, p95 latency, credits consumed, cost per channel

## Developer Experience

- [x] .env.example complete
- [x] Clean checkout runs from the README alone
- [x] Errors return the standard shape with a request_id the user can quote
- [x] API documentation page with working curl example (app/docs)

## CI & Build

- [x] Type check passes (pnpm typecheck)
- [x] Lint passes (pnpm lint)
- [x] All tests pass (npx vitest run)
- [x] Production build succeeds (pnpm build)
- [x] Client bundle secret check passes (node scripts/check-client-bundle.mjs)
- [x] Migrations run against a throwaway database in CI

## Definition of Done

**Developer flow verified:**
A developer with only the documentation page can:
1. Sign up at /signup
2. Buy a plan through Whop embedded checkout
3. Create an API key at /dashboard/keys
4. Call POST /v1/generate with curl
5. Receive a valid site spec
6. See the credit charge in their ledger with matching token counts

**Admin flow verified:**
An admin can:
1. Switch the serving channel to a different provider at /admin/channels
2. See the change take effect on the next request without a deploy
3. Find that change in the audit log at /admin/audit

All verification completed 2026-09-17.
