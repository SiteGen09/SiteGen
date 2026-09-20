import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('treats a missing profile embed as not suspended', async () => {
    state.result = { data: row({ profiles: null }), error: null };

    await expect(authenticateApiKey(BEARER)).resolves.toMatchObject({ apiKeyId: 'key-1' });
  });
});