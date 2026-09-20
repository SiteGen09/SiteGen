#!/usr/bin/env node
/**
 * Local-only seeding for things `supabase/seed.sql` cannot express:
 * the encrypted platform credential for the stub upstream, plus a test
 * account with credits and an API key for both endpoints.
 *
 * Idempotent: safe to re-run after `supabase db reset`.
 *
 * Usage: node scripts/seed-local-creds.mjs
 */
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { config } from 'dotenv';

config({ path: '.env.local' });

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} not set. Source it from .env.local before running this script.`);
    process.exit(1);
  }
  return value;
}

const admin = createClient(
  requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
  requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const STUB_BASE_URL = 'http://localhost:11435/v1';

// 1. Platform credential for the stub upstream, encrypted the way the app
//    expects (AES-256-GCM under ENCRYPTION_KEY).
const { data: existingCred } = await admin
  .from('provider_credentials')
  .select('id')
  .is('owner_id', null)
  .eq('provider', 'openai_compatible')
  .eq('base_url', STUB_BASE_URL)
  .eq('status', 'active')
  .maybeSingle();

if (existingCred !== null) {
  console.log('platform credential: already present');
} else {
  const masterKey = Buffer.from(requireEnv('ENCRYPTION_KEY'), 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update('test-stub-key', 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const { error } = await admin.from('provider_credentials').insert({
    owner_id: null,
    provider: 'openai_compatible',
    base_url: STUB_BASE_URL,
    ciphertext: '\\x' + ciphertext.toString('hex'),
    iv: '\\x' + iv.toString('hex'),
    auth_tag: '\\x' + authTag.toString('hex'),
    last_four: '-key',
    status: 'active',
  });
  if (error) {
    console.error('platform credential failed:', error.message);
    process.exit(1);
  }
  console.log('platform credential: created');
}

// 2. Test account with credits and a key scoped for both endpoints.
const EMAIL = 'local-dev@test.local';

const { data: userList } = await admin.auth.admin.listUsers();
let userId = userList?.users?.find((u) => u.email === EMAIL)?.id ?? null;

if (userId === null) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: 'test-password-12345',
    email_confirm: true,
  });
  if (error || !created.user) {
    console.error('createUser failed:', error?.message);
    process.exit(1);
  }
  userId = created.user.id;
  console.log(`test user: created (${EMAIL})`);
} else {
  console.log(`test user: already present (${EMAIL})`);
}

// Top up to at least 100k credits so E2E runs do not run dry.
const { data: balanceData } = await admin.rpc('get_balance', { p_user_id: userId });
const balance = Number(balanceData ?? 0);
if (balance < 100_000) {
  await admin.from('ledger').insert({
    user_id: userId,
    request_id: `local-grant-${Date.now()}`,
    kind: 'grant',
    credits: 100_000 - balance,
  });
  console.log(`credits: topped up to 100000 (was ${balance})`);
} else {
  console.log(`credits: ${balance}`);
}

// A fresh key each run: the plaintext exists only here, so it must be printed.
const secret = crypto.randomBytes(32).toString('base64url').slice(0, 43);
const key = `sk_live_${secret}`;

const { error: keyErr } = await admin.from('api_keys').insert({
  owner_id: userId,
  name: `local-dev-${new Date().toISOString().slice(0, 10)}`,
  key_hash: crypto.createHash('sha256').update(key, 'utf8').digest('hex'),
  key_prefix: key.slice(0, 8),
  last_four: key.slice(-4),
  scopes: ['generate', 'chat'],
  rate_limit_rpm: 600,
});
if (keyErr) {
  console.error('api key failed:', keyErr.message);
  process.exit(1);
}

console.log('');
console.log('API key (shown once):');
console.log(`  ${key}`);
console.log('');
console.log('Try it:');
console.log(`  curl http://localhost:3000/v1/models -H "Authorization: Bearer ${key}"`);
