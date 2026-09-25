import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticateApiKey } from '@/lib/api/api-key-auth';
import { hashApiKey } from '@/lib/keys/api-key';

/**
 * The suspension kill switch lives inside authenticateApiKey, which every
 * endpoint calls, so these tests cover the whole API surface at once.
 */

const KEY = `sk_live_${'A'.repeat(43)}`;
const BEARER = `Bearer ${KEY}`;

interface QueryResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

const state = vi.hoisted(() => ({
  /** null = hand back a live row built from `profileStatus` at resolve time. */
  result: null as QueryResult | null,
  profileStatus: 'active' as string,
}));

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'key-1',
    owner_id: 'user-1',
    key_hash: hashApiKey(KEY),
    scopes: ['generate'],
    status: 'active',
    rate_limit_rpm: 60,
    revoked_at: null,
    profiles: { status: state.profileStatus },
    ...overrides,
  };
}

function currentResult(): QueryResult {
  return state.result ?? { data: row(), error: null };
}

interface FakeQuery extends PromiseLike<QueryResult> {
  select(): FakeQuery;
  eq(): FakeQuery;
  update(): FakeQuery;
  maybeSingle(): PromiseLike<QueryResult>;
}

function fakeQuery(op: string): FakeQuery {
  const settle = (): QueryResult => (op === 'update' ? { data: null, error: null } : currentResult());
  const query: FakeQuery = {
    select: () => fakeQuery('select'),
    eq: () => query,
    update: () => fakeQuery('update'),
    maybeSingle: () => Promise.resolve(settle()),
    then: (onfulfilled, onrejected) => Promise.resolve(settle()).then(onfulfilled, onrejected),
  };
  return query;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: () => fakeQuery('select') }),
}));

beforeEach(() => {
  state.profileStatus = 'active';
  state.result = null;
});

it('blocks an active profile with a billing freeze', async () => {
  state.result = {data:row({profiles:{status:'active',billing_hold:true}}),error:null};
  await expect(authenticateApiKey(BEARER)).rejects.toMatchObject({status:403});
});

describe('authenticateApiKey suspension', () => {
  it('accepts an active account', async () => {
    const auth = await authenticateApiKey(BEARER);
    expect(auth).toMatchObject({ apiKeyId: 'key-1', ownerId: 'user-1' });
  });

  it('rejects a suspended account with forbidden', async () => {
    state.profileStatus = 'suspended';

    await expect(authenticateApiKey(BEARER)).rejects.toThrow(
      expect.objectContaining({ code: 'forbidden', status: 403 }),
    );
  });

  it('does not reveal suspension as a distinct reason', async () => {
    state.profileStatus = 'suspended';
    const suspended = await authenticateApiKey(BEARER).catch((err: unknown) => err);

    // An unknown key must be indistinguishable from a suspended account.
    state.result = { data: null, error: null };
    const unknownKey = await authenticateApiKey(BEARER).catch((err: unknown) => err);

    expect((suspended as Error).message).toBe('invalid or missing API key');
    expect((suspended as Error).message).toBe((unknownKey as Error).message);
    expect(unknownKey).toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('still rejects a revoked key before considering suspension', async () => {
    state.result = { data: row({ revoked_at: '2026-01-01T00:00:00Z' }), error: null };

    await expect(authenticateApiKey(BEARER)).rejects.toThrow(
      expect.objectContaining({ code: 'unauthorized', status: 401 }),
    );
  });

  it('denies access when the owner profile cannot be verified', async () => {
    state.result = { data: row({ profiles: null }), error: null };

    await expect(authenticateApiKey(BEARER)).rejects.toMatchObject({ status: 403 });
  });
});

describe('authenticateApiKey per-key settings', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns the key policy', async () => {
    state.result = {
      data: row({ quota_credits: '5000', used_credits: 12, allowed_models: ['gpt-5'], routing_provider_id: 'relay.fast', routing_sources: { 'gpt:chat': 'relay-gpt' } }),
      error: null,
    };
    const auth = await authenticateApiKey(BEARER);
    expect(auth.policy).toEqual({
      quotaCredits: 5000,
      usedCredits: 12,
      allowedModels: ['gpt-5'],
      routingProviderId: 'relay.fast',
      routingSources: { 'gpt:chat': 'relay-gpt' },
    });
  });

  it('treats a row without settings columns as unrestricted', async () => {
    const auth = await authenticateApiKey(BEARER);
    expect(auth.policy).toMatchObject({ quotaCredits: null, allowedModels: null, routingSources: {} });
  });

  it('rejects a disabled key like an unknown one', async () => {
    state.result = { data: row({ status: 'disabled' }), error: null };
    await expect(authenticateApiKey(BEARER)).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('rejects an expired key', async () => {
    state.result = { data: row({ expires_at: '2020-01-01T00:00:00Z' }), error: null };
    await expect(authenticateApiKey(BEARER)).rejects.toMatchObject({ status: 401 });
    state.result = { data: row({ expires_at: '2999-01-01T00:00:00Z' }), error: null };
    await expect(authenticateApiKey(BEARER)).resolves.toMatchObject({ apiKeyId: 'key-1' });
  });

  it('only accepts listed addresses from the trusted header', async () => {
    vi.stubEnv('GUARD_TRUSTED_IP_HEADER', 'cf-connecting-ip');
    state.result = { data: row({ allowed_ips: ['198.51.100.0/24'] }), error: null };
    const from = (ip: string) => new Request('https://app.test/v1/models', { headers: { 'cf-connecting-ip': ip } });

    await expect(authenticateApiKey(BEARER, undefined, from('198.51.100.9'))).resolves.toMatchObject({ apiKeyId: 'key-1' });
    await expect(authenticateApiKey(BEARER, undefined, from('203.0.113.1'))).rejects.toMatchObject({ status: 403 });
    // No request, so no address: a restricted key fails closed.
    await expect(authenticateApiKey(BEARER)).rejects.toMatchObject({ status: 403 });
  });
});
