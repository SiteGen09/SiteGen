import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import postgres from 'postgres';

config({ path: '.env.local', quiet: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const databaseUrl = process.env.DATABASE_URL!;
const origin = process.argv.find((arg) => arg.startsWith('http')) ?? 'http://localhost:3001';
for (const address of [url, databaseUrl, origin]) {
  if (!['localhost', '127.0.0.1'].includes(new URL(address).hostname)) throw new Error('Local verification only');
}
const db = postgres(databaseUrl, { max: 1 });
try {
  if (process.argv.includes('--apply-history-migration')) {
    const present = await db`SELECT to_regclass('public.routing_price_history') AS name`;
    if (!present[0]?.name) {
      const migration = await readFile('supabase/migrations/20260921100000_routing_price_history.sql', 'utf8');
      await db.begin(async (tx) => {
        await tx.unsafe(migration);
        await tx`INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
          VALUES ('20260921100000', 'routing_price_history', ${tx.array([migration])})
          ON CONFLICT (version) DO NOTHING`;
      });
      console.log('PASS: local price history migration applied.');
    }
  }
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const email = 'routing-providers-' + randomUUID() + '@test.local';
  const password = randomUUID();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error('Cannot create local verification account');
  try {
    const jar = new Map<string, string>();
    const client = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => { for (const cookie of cookies) jar.set(cookie.name, cookie.value); },
    } });
    const login = await client.auth.signInWithPassword({ email, password });
    if (login.error) throw new Error('Cannot authenticate local verification account');
    const headers = { cookie: [...jar].map(([name, value]) => name + '=' + value).join('; ') };
    const response = await fetch(origin + '/dashboard/routing', { headers, signal: AbortSignal.timeout(60000) });
    assert.equal(response.status, 200, 'routing page should render');
    const html = await response.text();
    const providers = [...html.matchAll(/data-provider="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(providers.length, 'provider cards should render');
    assert.equal(providers.length, new Set(providers).size, 'each provider should appear once');
    assert.equal(providers.filter((provider) => provider === 'relay.fast').length, 1);
    assert.equal(providers.filter((provider) => provider === 'kie.ai').length, 1);
    for (const content of ['configured models', 'Input / 1M', 'Output / 1M', 'Cache / 1M', 'Per job', 'Auto (automatic fallback)', 'Routing preferences', 'Price history']) {
      assert.ok(html.includes(content), 'missing routing content: ' + content);
    }
    assert.ok(!html.includes('upstreamModelId'));
    assert.ok(!html.includes('SUPABASE_SERVICE_ROLE_KEY'));
    const history = await fetch(origin + '/dashboard/routing?tab=history', { headers, signal: AbortSignal.timeout(60000) });
    assert.equal(history.status, 200, 'price history should render');
    const historyHtml = await history.text();
    assert.ok(historyHtml.includes('Price changed'));
    assert.ok(historyHtml.includes('Previous'));
    assert.ok(historyHtml.includes('New'));
    console.log('PASS: authenticated routing page renders one card per provider, descriptions, nested prices and Auto; history renders successfully.');
    console.log('Providers: ' + providers.join(', '));
  } finally {
    const removed = await admin.auth.admin.deleteUser(created.data.user.id);
    if (removed.error) throw new Error('Cannot remove local verification account');
  }
} finally { await db.end(); }
