/**
 * Cross-tenant isolation test (named deliverable).
 *
 * Authenticates as user A and proves every one of user B's rows in every
 * table is unreachable, and that server-only tables reject all client access.
 *
 * Requires a running local Supabase stack with migrations applied:
 *   pnpm supabase:start && pnpm db:migrate
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient;
}

async function createTestUser(tag: string): Promise<TestUser> {
  const email = `iso-${tag}-${Date.now()}@test.local`;
  const password = 'test-password-12345';
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);

  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn failed: ${signInError.message}`);

  return { id: data.user.id, email, client };
}

let userA: TestUser;
let userB: TestUser;
let bApiKeyId: string;

beforeAll(async () => {
  userA = await createTestUser('a');
  userB = await createTestUser('b');

  // Seed a channel (server-only table) for FK targets. The per-MTok rate
  // columns are NOT NULL, so they must be supplied.
  const { error: channelErr } = await admin.from('channels').upsert({
    id: 'iso-test-channel',
    label: 'Isolation Test',
    task: 'site.spec',
    provider: 'anthropic',
    model_id: 'test-model',
    input_per_mtok: 0,
    output_per_mtok: 0,
    cached_per_mtok: 0,
  });
  if (channelErr) throw new Error(`seed channel: ${channelErr.message}`);

  // Seed user B's rows in every owner-scoped table via service role.
  const { data: keyRow, error: keyErr } = await admin
    .from('api_keys')
    .insert({
      owner_id: userB.id,
      name: 'b-key',
      key_hash: `iso-test-hash-${Date.now()}`,
      key_prefix: 'sk_live_',
      last_four: 'bbbb',
    })
    .select('id')
    .single();
  if (keyErr) throw new Error(`seed api_keys: ${keyErr.message}`);
  bApiKeyId = keyRow.id;

  const { error: ledgerErr } = await admin.from('ledger').insert({
    user_id: userB.id,
    request_id: `iso-topup-${Date.now()}`,
    kind: 'topup',
    credits: 1000,
  });
  if (ledgerErr) throw new Error(`seed ledger: ${ledgerErr.message}`);

  const { error: usageErr } = await admin.from('usage_events').insert({
    request_id: `iso-usage-${Date.now()}`,
    user_id: userB.id,
    api_key_id: bApiKeyId,
    channel_id: 'iso-test-channel',
    status: 'ok',
  });
  if (usageErr) throw new Error(`seed usage_events: ${usageErr.message}`);

  const { error: credErr } = await admin.from('provider_credentials').insert({
    owner_id: userB.id,
    provider: 'anthropic',
    ciphertext: '\\x00',
    iv: '\\x00',
    auth_tag: '\\x00',
    last_four: 'bbbb',
  });
  if (credErr) throw new Error(`seed provider_credentials: ${credErr.message}`);

  const { error: billErr } = await admin.from('billing_events').insert({
    event_id: `iso-evt-${Date.now()}`,
    provider: 'whop',
    kind: 'test',
    payload: {},
  });
  if (billErr) throw new Error(`seed billing_events: ${billErr.message}`);

  const { error: auditErr } = await admin.from('admin_audit_log').insert({
    actor_id: userB.id,
    action: 'test',
    target: 'test',
  });
  if (auditErr) throw new Error(`seed admin_audit_log: ${auditErr.message}`);
}, 60_000);

afterAll(async () => {
  if (userA) await admin.auth.admin.deleteUser(userA.id);
  if (userB) await admin.auth.admin.deleteUser(userB.id);
  await admin.from('channels').delete().eq('id', 'iso-test-channel');
});

describe('cross-tenant isolation', () => {
  it('A cannot read B profile', async () => {
    const { data } = await userA.client.from('profiles').select('*').eq('id', userB.id);
    expect(data).toEqual([]);
  });

  it('A sees only own profile in unfiltered select', async () => {
    const { data } = await userA.client.from('profiles').select('*');
    expect(data?.length).toBe(1);
    expect(data?.[0]?.id).toBe(userA.id);
  });

  it('A cannot read B api_keys', async () => {
    const { data } = await userA.client.from('api_keys').select('*');
    expect(data).toEqual([]);
  });

  it('A cannot read B entitlements', async () => {
    const { data } = await userA.client.from('entitlements').select('*').eq('user_id', userB.id);
    expect(data).toEqual([]);
  });

  it('A cannot read B ledger rows', async () => {
    const { data } = await userA.client.from('ledger').select('*');
    expect(data).toEqual([]);
  });

  it('A cannot read B usage_events', async () => {
    const { data } = await userA.client.from('usage_events').select('*');
    expect(data).toEqual([]);
  });

  it('A has zero access to channels', async () => {
    const { data, error } = await userA.client.from('channels').select('*');
    // Either permission error or empty result — both prove inaccessibility.
    expect(error !== null || data?.length === 0).toBe(true);
  });

  it('A has zero access to provider_credentials', async () => {
    const { data, error } = await userA.client.from('provider_credentials').select('*');
    expect(error !== null || data?.length === 0).toBe(true);
  });

  it('A has zero access to billing_events', async () => {
    const { data, error } = await userA.client.from('billing_events').select('*');
    expect(error !== null || data?.length === 0).toBe(true);
  });

  it('A has zero access to admin_audit_log', async () => {
    const { data, error } = await userA.client.from('admin_audit_log').select('*');
    expect(error !== null || data?.length === 0).toBe(true);
  });

  it('A cannot insert into ledger', async () => {
    const { error } = await userA.client.from('ledger').insert({
      user_id: userA.id,
      request_id: `iso-forge-${Date.now()}`,
      kind: 'topup',
      credits: 999999,
    });
    expect(error).not.toBeNull();
  });

  it('A cannot insert an api_key directly', async () => {
    const { error } = await userA.client.from('api_keys').insert({
      owner_id: userA.id,
      name: 'forged',
      key_hash: `forged-${Date.now()}`,
      key_prefix: 'sk_live_',
      last_four: 'aaaa',
    });
    expect(error).not.toBeNull();
  });

  it('A cannot update own role to admin', async () => {
    await userA.client.from('profiles').update({ role: 'admin' }).eq('id', userA.id);
    // Regardless of reported error, verify the role did not change.
    const { data } = await admin.from('profiles').select('role').eq('id', userA.id).single();
    expect(data?.role).toBe('developer');
  });

  it("A cannot update B's profile", async () => {
    await userA.client.from('profiles').update({ email: 'hacked@evil.com' }).eq('id', userB.id);
    const { data } = await admin.from('profiles').select('email').eq('id', userB.id).single();
    expect(data?.email).toBe(userB.email);
  });

  it('A cannot delete B ledger rows', async () => {
    await userA.client.from('ledger').delete().eq('user_id', userB.id);
    const { data } = await admin.from('ledger').select('id').eq('user_id', userB.id);
    expect(data?.length).toBeGreaterThan(0);
  });

  it('anonymous client reads nothing anywhere', async () => {
    const anon = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    for (const table of [
      'profiles', 'api_keys', 'entitlements', 'ledger', 'usage_events',
      'channels', 'provider_credentials', 'billing_events', 'admin_audit_log',
    ]) {
      const { data, error } = await anon.from(table).select('*');
      expect(error !== null || data?.length === 0, `table ${table} leaked to anon`).toBe(true);
    }
  });
});
