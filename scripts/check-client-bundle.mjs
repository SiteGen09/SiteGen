#!/usr/bin/env node
/**
 * CI check: no secret may be reachable from the client bundle.
 * Scans .next static/client output for known secret prefixes and
 * server-only env names. Exits 1 on any hit.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['.next/static', '.next/server/app'].filter(existsSync);
// .next/server is server-side, but scanning app client-reference manifests
// there catches secrets accidentally serialized into RSC payload boundaries.

const PATTERNS = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: 'Platform API key', re: /sk_live_[0-9A-Za-z]{43}/ },
  { name: 'Supabase secret key', re: /sb_secret_[A-Za-z0-9_-]{8,}/ },
  { name: 'Whop API key', re: /whop_[A-Za-z0-9]{16,}/ },
  { name: 'service-role env name in client static', re: /SUPABASE_SERVICE_ROLE_KEY/, staticOnly: true },
  { name: 'encryption key env name in client static', re: /ENCRYPTION_KEY/, staticOnly: true },
  { name: 'webhook secret env name in client static', re: /WHOP_WEBHOOK_SECRET/, staticOnly: true },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(js|json|txt|html|css)$/.test(entry)) yield full;
  }
}

if (ROOTS.length === 0) {
  console.error('check-client-bundle: no .next output found — run `pnpm build` first');
  process.exit(1);
}

let failed = false;
for (const root of ROOTS) {
  const isStatic = root.includes('static');
  for (const file of walk(root)) {
    const content = readFileSync(file, 'utf-8');
    for (const { name, re, staticOnly } of PATTERNS) {
      if (staticOnly && !isStatic) continue;
      const m = content.match(re);
      if (m) {
        console.error(`SECRET LEAK: ${name} in ${file}: ${m[0].slice(0, 24)}…`);
        failed = true;
      }
    }
  }
}

if (failed) process.exit(1);
console.log('check-client-bundle: clean');
