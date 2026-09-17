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

## Production deployment

1. Create a Supabase project in ap-southeast-1
2. Link: `supabase link --project-ref your-ref`
3. Push migrations: `supabase db push`
4. Set environment variables in Vercel (use `.env.example` as reference)
5. Deploy: `vercel --prod`

## Architecture

- **Auth**: Supabase email auth, RLS-protected tables
- **Billing**: Whop webhooks → entitlements + credit ledger
- **Credits**: Hold/settle pattern with concurrency safety
- **AI**: Vercel AI SDK with Anthropic native SDK for prompt caching
- **Admin**: Server-side role checks, audit log for all mutations
