# sitegen

AI website generation platform with authentication, credit-based billing, and multi-provider routing.

## Local Setup

### Prerequisites

- Node.js 22+
- pnpm
- [Supabase CLI](https://supabase.com/docs/guides/cli)

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start Supabase

```bash
pnpm supabase:start
```

This starts a local Supabase stack (Postgres, Auth, Storage). Note the `API URL` and `anon key` output.

### 3. Configure environment

Copy `.env.example` to `.env.local` and fill in:

- Supabase credentials from the previous step (already set for local defaults)
- `ANTHROPIC_API_KEY` for AI generation
- Generate `ENCRYPTION_KEY`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

### 4. Run migrations

```bash
pnpm db:migrate
```

### 5. Start the dev server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

Email signup requires a six-digit verification code. Local emails appear in
[Mailpit](http://127.0.0.1:54324). See [AUTH_SETUP.md](./AUTH_SETUP.md) for auth details and
[DOMAIN_EMAIL_SETUP.md](./DOMAIN_EMAIL_SETUP.md) and [CLOUDFLARE_TUNNEL_SETUP.md](./CLOUDFLARE_TUNNEL_SETUP.md) for the gensite.tech and Titan Email setup.

## Development

### Running tests

```bash
pnpm test
```

### Type checking

```bash
pnpm typecheck
```

### Database

- Generate migrations: `pnpm db:generate`
- Apply migrations: `pnpm db:migrate`
- Studio UI: `pnpm db:studio`

### Supabase

- Status: `pnpm supabase:status`
- Stop: `pnpm supabase:stop`

## Promoting a user to admin

```sql
-- Run in Supabase SQL Editor or via psql
UPDATE profiles SET role = 'admin' WHERE email = 'your-email@example.com';
```

## Production deployment on the local Cloudflare Tunnel

The supported gensite.tech arrangement keeps the complete Next.js app on the
Windows computer and exposes it through the named Cloudflare Tunnel. Supabase
should still be hosted, because visitors cannot reach a Supabase instance on
`127.0.0.1`. Titan SMTP, Google OAuth, and Whop all call the public HTTPS URL.

1. Create a hosted Supabase project and record its project ref, API keys, and
   production database URL.
2. Review the migration filenames, link the CLI to that project, and push only
   after confirming the target project is correct: `supabase link --project-ref
   your-ref`, then `supabase db push`.
3. Configure Titan SMTP and the `gensite.tech` DKIM record, then configure
   Supabase Auth using [DOMAIN_EMAIL_SETUP.md](./DOMAIN_EMAIL_SETUP.md).
4. Configure Google OAuth and Whop using [AUTH_SETUP.md](./AUTH_SETUP.md) and
   [WHOP_BILLING.md](./WHOP_BILLING.md).
5. Fill the production values in `.env.local` and run
   `pnpm check:production`. Use the hosted Supabase URL and database URL; do
   not leave the local defaults.
6. Build and start Next.js, run the tunnel, and verify
   `https://gensite.tech/healthz`. The full runbook is
   [CLOUDFLARE_TUNNEL_SETUP.md](./CLOUDFLARE_TUNNEL_SETUP.md).
7. Schedule `/api/cron/reconcile`, `/api/cron/probe-models`, and
   `/api/cron/sweep-media` through Windows Task Scheduler or an external
   scheduler. Vercel cron does not run on a local tunnel.

To move production to a rented Linux VPS, follow [DEPLOY_VPS.md](./DEPLOY_VPS.md).

If you later move the frontend to Vercel, treat that as a different topology;
the current app uses same-origin `/api` and `/v1` routes.

## Architecture

- **Auth**: Supabase email/password with email code verification, Google OAuth, RLS-protected tables
- **Billing**: Whop webhooks → entitlements + credit ledger
- **Credits**: Hold/settle pattern with concurrency safety
- **AI**: Vercel AI SDK with Anthropic native SDK for prompt caching
- **Admin**: Server-side role checks, audit log for all mutations
