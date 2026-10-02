<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Hosting and deployment

- Production today is a Windows PC behind the Cloudflare Tunnel `gensite`: see [CLOUDFLARE_TUNNEL_SETUP.md](./CLOUDFLARE_TUNNEL_SETUP.md). It runs `next start` on 127.0.0.1:3000; after `pnpm build`, restart it with `E:\sitegen\hosting\windows\manage.ps1 restart` on that PC. The host scripts, their logs (`hosting/logs`, git-ignored) and local backups (`hosting/backups`, git-ignored, may hold secrets) all live in this repo folder: see [hosting/windows/README.md](./hosting/windows/README.md). Never run `git clean -x` here.
- To deploy or update on a Linux VPS, follow [DEPLOY_VPS.md](./DEPLOY_VPS.md) step by step, starting with its "Rules an agent must not break". Build with `BUILD_STANDALONE=1 pnpm build`; never hard-code `output: "standalone"` in `next.config.ts`.
- Cloudflare caching is set up (CLOUDFLARE_TUNNEL_SETUP.md section 6). Never add a "Cache Everything" rule for HTML: pages carry per-user Supabase cookies.

# Docker and local Supabase

- Docker Desktop is off by default on this PC. The live site does not need it: `next start`, `cloudflared` and the cron jobs run natively, and `.env.local` points to hosted Supabase.
- Docker only runs the local Supabase stack (ports 54321–54327), which DB tests, migration checks and local Studio/Mailpit use. Start it only when a task needs it: `docker desktop start`, then `npx supabase start`.
- When the task is done, shut it down again: `npx supabase stop` (keeps local data), then `docker desktop stop`. Never use `npx supabase stop --no-backup`; it deletes the local data.
