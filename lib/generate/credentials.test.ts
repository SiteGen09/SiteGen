import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getUserCredential } from '@/lib/generate/credentials';

/**
 * A BYOK credential is decrypted the moment it is read, before any caller has
 * compared its provider to the channel's. That made two failures possible that
 * had nothing to do with the call being served: a credential for an unrelated
 * provider being decrypted at all, and one corrupt row failing every request
 * the user made.
 */

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}

const state = vi.hoisted(() => ({
  result: { data: null, error: null } as QueryResult,
  filters: [] as string[],
  decryptThrows: false,
}));

interface FakeQuery extends PromiseLike<QueryResult> {
  select(): FakeQuery;
  eq(column: string, value: unknown): FakeQuery;
  limit(count: number): FakeQuery;
  maybeSingle(): PromiseLike<QueryResult>;
}

function fakeQuery(): FakeQuery {
  const query: FakeQuery = {
    select: () => query,
    eq: (column, value) => {
      state.filters.push(`${column}=${String(value)}`);
      return query;
    },
    limit: () => query,
    maybeSingle: () => Promise.resolve(state.result),
    then: (onfulfilled, onrejected) => Promise.resolve(state.result).then(onfulfilled, onrejected),
  };
  return query;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: () => fakeQuery() }),
}));

vi.mock('@/lib/crypto/aes', () => ({
  decryptSecret: (ciphertext: Buffer) => {
    if (state.decryptThrows) throw new Error('Invalid authentication tag length: 1');
    return `decrypted:${ciphertext.toString('utf8')}`;
  },
}));

vi.mock('@/lib/log', () => ({
  logger: () => ({ error: () => {}, warn: () => {}, info: () => {} }),
}));

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'openai_compatible',
    base_url: 'https://api.kie.ai/v1',
    ciphertext: '\\x6b6965',
    iv: '\\x6976',
    auth_tag: '\\x746167',
    ...overrides,
  };
}

beforeEach(() => {
  state.result = { data: null, error: null };
  state.filters = [];
  state.decryptThrows = false;
});

describe('getUserCredential', () => {
  it('returns null when the user has no credential', async () => {
    expect(await getUserCredential('user-1')).toBeNull();
  });

  it('decrypts a matching credential', async () => {
    state.result = { data: row(), error: null };
    const creds = await getUserCredential('user-1', 'openai_compatible');
    expect(creds).toMatchObject({ provider: 'openai_compatible', apiKey: 'decrypted:kie' });
  });

  /**
   * The narrowing that matters: an anthropic credential must never be read —
   * let alone decrypted — while serving an openai_compatible channel.
   */
  it('scopes the lookup to the requested provider', async () => {
    state.result = { data: null, error: null };
    await getUserCredential('user-1', 'anthropic_compatible');
    expect(state.filters).toContain('provider=anthropic_compatible');
    expect(state.filters).toContain('owner_id=user-1');
  });

  it('does not filter by provider when none is given', async () => {
    await getUserCredential('user-1');
    expect(state.filters.some((f) => f.startsWith('provider='))).toBe(false);
  });

  /**
   * The bug this replaces: one corrupt row made every call for that user fail
   * with a 500, including calls that would never have used the credential.
   * Unusable is unusable — falling back to the platform key is the only
   * outcome that still serves the request.
   */
  it('treats an undecryptable credential as absent rather than failing the call', async () => {
    state.result = { data: row(), error: null };
    state.decryptThrows = true;
    expect(await getUserCredential('user-1', 'openai_compatible')).toBeNull();
  });

  it('treats a malformed row as absent too', async () => {
    state.result = { data: { provider: 'nonsense', base_url: null }, error: null };
    expect(await getUserCredential('user-1')).toBeNull();
  });

  /** A database fault is still ours, and must not be silently swallowed. */
  it('still throws when the lookup itself fails', async () => {
    state.result = { data: null, error: { message: 'connection reset' } };
    await expect(getUserCredential('user-1')).rejects.toThrow(/provider credentials/);
  });
});
