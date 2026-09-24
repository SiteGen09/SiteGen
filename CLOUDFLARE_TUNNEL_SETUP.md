# Cloudflare Tunnel setup for gensite.tech

This project is a full-stack Next.js app. The simplest local-hosting arrangement is to expose the complete app through Cloudflare Tunnel:

- https://gensite.tech -> local Next.js server on 127.0.0.1:3000
- Titan Email continues to use the domain MX records
- No separate api.gensite.tech subdomain is needed

Use this for a private beta or temporary hosting. A local computer is not a reliable long-term production server because it can lose power, internet access, or updates. To move the app to a Linux VPS behind the same Cloudflare setup, follow [DEPLOY_VPS.md](./DEPLOY_VPS.md).

## 1. Put the DNS zone in Cloudflare

Add gensite.tech to Cloudflare. Before changing nameservers at the registrar, copy the existing DNS records into Cloudflare:

- Titan MX: mx1.titan.email and mx2.titan.email, with the priorities shown by Titan
- Titan SPF TXT: v=spf1 include:spf.titan.email ~all
- Titan DKIM record from the Titan dashboard
- DMARC at _dmarc.gensite.tech

Do not proxy MX records. After all records are present, change the registrar nameservers to the two nameservers Cloudflare gives you. DNS changes can take time to propagate.

## 2. Authenticate and create the tunnel

Run these commands in PowerShell on the computer that will run the app:

~~~powershell
cloudflared tunnel login
cloudflared tunnel create gensite
~~~

The login opens a Cloudflare authorization page. The create command prints a tunnel UUID and stores a credentials file under your Windows user profile. Keep that credentials file private.

## 3. Create the tunnel configuration

Create `%USERPROFILE%\.cloudflared\config.yml` and replace the placeholders:

~~~yaml
tunnel: YOUR_TUNNEL_UUID
credentials-file: 'C:\\Users\\YOUR_WINDOWS_USER\\.cloudflared\\YOUR_TUNNEL_UUID.json'

ingress:
  - hostname: gensite.tech
    service: http://127.0.0.1:3000
  - service: http_status:404
~~~

Create the DNS route:

~~~powershell
cloudflared tunnel route dns gensite gensite.tech
~~~

The command above creates the Cloudflare DNS route. Do not run `cloudflared tunnel run gensite` until `config.yml` exists; without ingress rules, Cloudflare returns HTTP 503.

## 4. Run the application

Set the production values in the local environment file. At minimum:

~~~text
NEXT_PUBLIC_APP_URL=https://gensite.tech
NEXT_PUBLIC_SUPPORT_EMAIL=admin@gensite.tech
~~~

Also use the hosted Supabase URL and keys, production database URL, encryption key, AI provider credentials, Whop credentials, and cron secret. Never put SMTP passwords or service-role keys in a NEXT_PUBLIC variable.

Enable per-IP generation limits with the header Cloudflare sets on every proxied request:

~~~text
GUARD_TRUSTED_IP_HEADER=cf-connecting-ip
~~~

This is only safe while visitors cannot reach port 3000 directly, which is why `pnpm start` binds to 127.0.0.1.

Build and start the app from E:\\sitegen:

~~~powershell
pnpm install
pnpm build
pnpm start
~~~

In a second PowerShell window, start the tunnel:

~~~powershell
cloudflared tunnel run gensite
~~~

Open https://gensite.tech/healthz and confirm it returns the health response. Install cloudflared as a Windows service after the manual test succeeds so the tunnel starts after reboots.

## 5. Update external services

For hosted Supabase Auth use:

- Site URL: https://gensite.tech
- Redirect URL: https://gensite.tech/auth/callback

Point the Whop webhook to:

- https://gensite.tech/api/webhooks/whop

The Vercel cron entries in vercel.json do not run when the app is only hosted locally. Use Windows Task Scheduler or an external scheduler to call the cron endpoints with the CRON_SECRET authorization header.

## 6. Cloudflare caching and settings (free plan)

The app sends the caching headers itself:

- `/_next/static/*`: `public, max-age=31536000, immutable` from Next.js. Cloudflare caches these by extension without any rule.
- `public/` files (svg, png, webp, ico, ...): one hour in the browser, one day at the edge, set in `next.config.ts`. Purge the Cloudflare cache after replacing one.
- Pages, `/api/*`, `/v1/*`: not cached. Pages carry per-user Supabase cookies.

In the Cloudflare dashboard for gensite.tech:

- Caching -> Cache Rules: add a rule "URI Path starts with `/api/` OR `/v1/` OR `/auth/` OR `/dashboard` OR `/admin`" -> Bypass cache, as a safety net.
- Never add a "Cache Everything" rule for HTML. It would serve one user's session or dashboard to other visitors.
- Speed -> Optimization: Rocket Loader off. It rewrites script loading and breaks React hydration.
- Scrape Shield: Email Address Obfuscation off. It rewrites the `mailto:` support links and causes hydration mismatches.
- On: Always Use HTTPS, HTTP/3, Early Hints, and Caching -> Tiered Cache -> Smart Tiered Cache.

Proxied requests must start responding within 100 seconds or Cloudflare returns HTTP 524. Streaming responses send headers immediately and are unaffected.

## If the frontend will be on Vercel instead

Use a separate api.gensite.tech tunnel and keep gensite.tech on Vercel. That is a different architecture: the current browser code uses same-origin /api and /v1 paths, so it needs proxy rewrites or an API-base URL/CORS update before it will work correctly.
