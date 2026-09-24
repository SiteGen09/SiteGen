# Generation Guardrails

The default is local, deterministic screening. No moderation model is hosted and
no external moderation request is made unless MODERATION_MODE=remote is explicitly
configured. These narrow English rules are a basic barrier, not comprehensive
content moderation. They do not inspect image pixels or guarantee provider acceptance.

## Defaults

- 60 generation requests per minute per account, shared across API keys and dashboard.
- 180 requests per minute per trusted client IP, shared across accounts.
- 4 simultaneous generations per account, including queued/running media jobs.
- 5 distinct policy violations in 24 hours trigger a 1-hour generation cooldown.
- Existing manually suspended accounts cannot generate through any supported route.
- Request bodies are capped at 1 MiB, or 4 MiB for dashboard chat attachments.
- Combined text input, including tool definitions, is capped at 200,000 characters.

Limits are configured through the GUARD_* variables in .env.example. Existing
per-key limits still apply. Invalid or missing guard database configuration blocks
generation rather than silently bypassing enforcement.

## Deployment

Apply supabase/migrations/20260921000700_generation_guardrails.sql before deploying
the application. It adds service-role-only tables and RPCs. It requires the existing
profiles, abuse_strikes and media_jobs migrations. This change has been applied to
the local development database only.

Vercel uses x-vercel-forwarded-for. Other hosting requires GUARD_TRUSTED_IP_HEADER
to name a header overwritten by the trusted reverse proxy, and direct origin access
must be blocked. Otherwise IP limiting is skipped; account controls still apply.
Raw IP addresses are not stored; a keyed hash identifies each IP bucket.

Generation leases survive streaming and expire after ten minutes if the process
dies. Async media remains counted through its stored queued/running job. The existing
media sweeper must remain operational so abandoned jobs reach a terminal state.

## Policy Handling

Local checks cover a small set of explicit creation requests involving child sexual
exploitation and credential-stealing/encrypting malware. They intentionally allow
discussion, reporting, prevention, and medical content. They can miss paraphrases,
other languages, obfuscation, and harmful content inside image attachments.

Explicit provider policy error codes, content-filter finish reasons, and recognized
policy rejection messages are recorded once per request. Generic 403, 422, and
provider outages do not count as violations. A policy rejection stops channel
fallback. SDK retries are disabled so policy errors cannot be retried internally;
the existing gateway fallback still handles transient outages.

Violations are visible in the existing admin strike count. Cooldowns are automatic
and expire without changing the account's permanent suspension status. Provider
rejections are reactive: the provider has already received that request.

## Verification

Run the guardrails unit tests and the affected chat/media tests with Vitest. For
real concurrency and permission checks, set GUARD_TEST_DATABASE_URL to a local
Postgres connection and run tests/guardrails-database.test.ts. The database tests
refuse remote hosts and clean up their test users.
