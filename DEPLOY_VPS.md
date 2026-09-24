# Deploying to a Linux VPS

Production currently runs on a Windows PC: `next start` on 127.0.0.1:3000 behind the
Cloudflare Tunnel `gensite` ([CLOUDFLARE_TUNNEL_SETUP.md](./CLOUDFLARE_TUNNEL_SETUP.md)),
supervised by Task Scheduler scripts in `E:\sitegen-host` on that PC. This runbook moves the
same app to a rented Linux VPS. It is written for humans and AI agents; follow it in order.

## Rules an agent must not break

1. **Build with `BUILD_STANDALONE=1`.** `next.config.ts` emits `.next/standalone` only when
   that variable is `1`. Do not edit `next.config.ts` to hard-code `output: "standalone"`:
   the Windows host runs `next start`, which warns under standalone, and Windows cannot run
   the standalone bundle (pnpm symlinks fail with `EPERM`).
2. **Run `node server.js` from `.next/standalone`, never `next start`,** for a standalone build.
3. **After every build, copy `public/` and `.next/static/` into `.next/standalone/`.** The
   standalone bundle does not include them; without the copy, CSS, JS and images return 404.
4. **Pass the env file explicitly: `node --env-file=<path>/.env.local server.js`.**
   `server.js` does not read `.env.local` by itself.
5. **Set `HOSTNAME=127.0.0.1` explicitly.** `server.js` binds to `$HOSTNAME` and defaults to
   `0.0.0.0`. Linux shells and Docker set `HOSTNAME` to the machine or container name.
6. **`.env.local` must exist in the checkout before `pnpm build`.** `NEXT_PUBLIC_*` values are
   baked into the build; changing them requires a rebuild.
7. **Deploy from a `git clone`.** `pnpm install` runs the `prepare` script
   (`git config core.hooksPath .githooks`), which fails outside a git checkout. Uploading a
   zip or rsyncing files without `.git` breaks the install.
8. **Cron jobs run in exactly one place,** and call `http://127.0.0.1:3000`, not
   `https://gensite.tech`. Cloudflare cuts proxied requests at 100 seconds and `reconcile` can
   run for minutes.
9. **Keep the app port closed to the internet.** The app listens on 127.0.0.1 and only the
   tunnel reaches it. `GUARD_TRUSTED_IP_HEADER=cf-connecting-ip` is safe only under that
   condition, because anyone who reaches the port directly could forge the header.
10. **Database migrations:** never run `supabase db push` until `supabase link` points at the
    confirmed hosted project ref. The VPS move itself needs no migration.

Nothing in Cloudflare changes with the move: the cache rule, the dashboard settings in
CLOUDFLARE_TUNNEL_SETUP.md section 6, and the cache headers in `next.config.ts` all carry
over. Supabase Auth URLs, Google OAuth and the Whop webhook keep pointing at
https://gensite.tech, so they need no change either.

Accounts: commands starting with `sudo` run as your admin login. The app runs as the
unprivileged `sitegen` user, which has no sudo. Open a shell as that user with
`sudo -iu sitegen`.

## Requirements

- Ubuntu 24.04 or Debian 12, x86-64, 2 GB RAM or more (`next build` is the peak; on 1 GB add swap).
- Node.js 24 LTS, pnpm 12.4.2 (the lockfile is v9), git, curl, cron, cloudflared.
- Server clock in UTC (`timedatectl`); the cron schedule below assumes it.

## 1. Prepare the server

~~~bash
sudo apt-get update && sudo apt-get install -y git curl cron
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm@12.4.2
sudo timedatectl set-timezone UTC
sudo useradd --system --create-home --home-dir /srv/sitegen --shell /bin/bash sitegen
~~~

Install cloudflared from Cloudflare's package repository (https://pkg.cloudflare.com).

## 2. Get the code and the environment file

~~~bash
sudo -iu sitegen
git clone https://github.com/SiteGen09/SiteGen.git /srv/sitegen/app
~~~

Create `/srv/sitegen/app/.env.local` with the production values. The source of truth is
`E:\sitegen\.env.local` on the current Windows host; transfer it over a private channel and
never commit it. Keep `GUARD_TRUSTED_IP_HEADER=cf-connecting-ip`.

~~~bash
chmod 600 /srv/sitegen/app/.env.local
cd /srv/sitegen/app && pnpm install --frozen-lockfile && pnpm check:production
~~~

`check:production` must end with "Production environment values passed the required checks."

## 3. Build

As the `sitegen` user, in `/srv/sitegen/app`:

~~~bash
BUILD_STANDALONE=1 pnpm build
cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/
~~~

## 4. Run the app with systemd

`/etc/systemd/system/sitegen.service`:

~~~ini
[Unit]
Description=SiteGen Next.js (standalone)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=sitegen
WorkingDirectory=/srv/sitegen/app/.next/standalone
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
ExecStart=/usr/bin/node --env-file=/srv/sitegen/app/.env.local server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
~~~

~~~bash
sudo systemctl daemon-reload
sudo systemctl enable --now sitegen
curl -fsS http://127.0.0.1:3000/healthz
~~~

`/healthz` returns `{"ok":true,"db":true}` when the app can reach Supabase.

## 5. Cron jobs

These replace `vercel.json` (unused off Vercel) and the Windows `gensite-cron-*` tasks. Every
endpoint is `GET /api/cron/<job>` with `Authorization: Bearer <CRON_SECRET>`.

`/srv/sitegen/cron.sh` (owner `sitegen`, mode 700):

~~~bash
#!/usr/bin/env bash
# Calls one cron endpoint on the local server with the CRON_SECRET bearer token.
set -euo pipefail
job="$1"
secret=$(grep -E '^CRON_SECRET=' /srv/sitegen/app/.env.local | head -1 | cut -d= -f2- | tr -d "\"'")
# The header goes through stdin so the secret never shows up in `ps`.
printf 'header = "Authorization: Bearer %s"\n' "$secret" |
  curl -fsS --max-time 330 --config - "http://127.0.0.1:3000/api/cron/$job"
echo
~~~

Crontab for `sitegen` (`crontab -e`), times in UTC, matching the current schedule:

~~~text
*/2 * * * * /srv/sitegen/cron.sh sweep-media  >> /srv/sitegen/cron.log 2>&1
5 * * * *   /srv/sitegen/cron.sh probe-models >> /srv/sitegen/cron.log 2>&1
0 17 * * *  /srv/sitegen/cron.sh reconcile    >> /srv/sitegen/cron.log 2>&1
~~~

Install the crontab only at cutover (step 7), after the Windows crons are disabled.

## 6. Cloudflare Tunnel on the VPS

Use a new tunnel so the VPS can be tested before it takes traffic and rollback is one command.

~~~bash
cloudflared tunnel login
cloudflared tunnel create gensite-vps
~~~

Run these as the admin user. Move the credentials file that `tunnel create` wrote
(`sudo mkdir -p /etc/cloudflared && sudo mv ~/.cloudflared/<UUID>.json /etc/cloudflared/`)
and create `/etc/cloudflared/config.yml`:

~~~yaml
tunnel: <UUID>
credentials-file: /etc/cloudflared/<UUID>.json

ingress:
  - hostname: vps.gensite.tech
    service: http://127.0.0.1:3000
  - hostname: gensite.tech
    service: http://127.0.0.1:3000
  - service: http_status:404
~~~

~~~bash
cloudflared tunnel route dns gensite-vps vps.gensite.tech
sudo cloudflared service install
sudo systemctl enable --now cloudflared
curl -fsS https://vps.gensite.tech/healthz
~~~

## 7. Cutover

1. `https://vps.gensite.tech/healthz` is healthy and `sudo systemctl status sitegen cloudflared` shows both active.
2. Point the domain at the VPS tunnel:
   `cloudflared tunnel route dns --overwrite-dns gensite-vps gensite.tech`
3. On the Windows PC: `E:\sitegen-host\manage.ps1 disable` (stops the app, the old tunnel and the crons, and keeps them off).
4. On the VPS: install the crontab from step 5.
5. Verify from outside:
   - `https://gensite.tech/healthz` returns 200.
   - `/_next/static/...` shows `cf-cache-status: HIT` on a repeat request.
   - `/api/...` shows `cf-cache-status: DYNAMIC`.
   - Sign-in works, and `/srv/sitegen/cron.log` fills in.

Rollback: `cloudflared tunnel route dns --overwrite-dns gensite gensite.tech`, then
`E:\sitegen-host\manage.ps1 enable` on the PC, then remove the VPS crontab.

## Deploying an update

From the admin login:

~~~bash
cd /srv/sitegen/app
sudo -u sitegen -H git pull --ff-only
sudo -u sitegen -H pnpm install --frozen-lockfile
sudo -u sitegen -H env BUILD_STANDALONE=1 pnpm build
sudo -u sitegen -H cp -r public .next/standalone/
sudo -u sitegen -H cp -r .next/static .next/standalone/.next/
sudo systemctl restart sitegen
curl -fsS http://127.0.0.1:3000/healthz
~~~

If `pnpm build` fails, read the first error and fix its cause. Never restart onto a
failed build: `.next/standalone` would then be missing or incomplete.

The build replaces `.next` under the running server, so expect errors for a minute or two
until the restart. If the pull added files under `supabase/migrations`, apply them to the hosted
project first (rule 10). After replacing a file in `public/`, purge it in Cloudflare.

## Scaling out later

- No app code writes to local disk. Sessions live in Supabase cookies, and the generation
  guardrails are enforced in Postgres. Before relying on several instances, check for
  in-process caches.
- More capacity: run the same build on more VPSes, each with a `cloudflared` connector for
  the same tunnel. Cloudflare spreads requests across connectors. Keep cron on one machine only.
- Each instance opens up to `DB_POOL_MAX` Postgres connections; keep the total under the
  Supabase plan's limit.
- Docker: build the image with the same steps (`BUILD_STANDALONE=1`, the two copies,
  `node server.js`). Pass `NEXT_PUBLIC_*` as build arguments, pass secrets at run time, and
  never copy `.env.local` into the image.
