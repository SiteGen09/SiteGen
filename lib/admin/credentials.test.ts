import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolvePlatformCreds } from '@/lib/admin/credentials';

/**
 * The merged resolver must match on provider AND base URL: with several
 * OpenAI-compatible upstreams configured, matching on provider alone handed
 * the wrong provider's key to a request (and made the admin "Test" button pass
 * while the live call failed).
 */

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}

const state = vi.hoisted(() => ({
  result: { data: null, error: null } as QueryResult,
  filters: [] as string[],
  orders: [] as string[],
  limits: [] as number[],
}));

interface FakeQuery extends PromiseLike<QueryResult> {
  select(): FakeQuery;
  eq(column: string, value: unknown): FakeQuery;
  is(column: string, value: unknown): FakeQuery;
  or(filter: string): FakeQuery;
  in(column: string, values: readonly string[]): FakeQuery;
  order(column: string, options?: unknown): FakeQuery;
  limit(count: number): FakeQuery;
  maybeSingle(): PromiseLike<QueryResult>;
}

function fakeQuery(): FakeQuery {
  const query: FakeQuery = {
    select: () => query,
    eq: (column, value) => {
      state.filters.push(`eq:${column}=${String(value)}`);
      return query;
    },
    is: (column, value) => {
      state.filters.push(`is:${column}=${String(value)}`);
      return query;
    },
    or: (filter) => {
      state.filters.push(`or:${filter}`);
      return query;
    },
    in: (column, values) => {
      state.filters.push(`in:${column}=${values.join('|')}`);
      return query;
    },
    order: (column, options) => {
      state.orders.push(`${column}:${JSON.stringify(options)}`);
      return query;
    },
    limit: (count) => {
      state.limits.push(count);
      return query;
    },
    maybeSingle: () => Promise.resolve(state.result),
    then: (onfulfilled, onrejected) => Promise.resolve(state.result).then(onfulfilled, onrejected),
  };
  return query;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: () => fakeQuery() }),
}));

vi.mock('@/lib/crypto/aes', () => ({
  decryptSecret: (ciphertext: Buffer) => `decrypted:${ciphertext.toString('utf8')}`,
}));

/** Row as PostgREST returns it: `bytea` is a `\x`-prefixed hex string. */
function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    base_url: 'https://api.kie.ai/v1',
    ciphertext: '\\x6b6965',
    iv: '\\x00',
    auth_tag: '\\x00',
    created_at: '2026-09-17T13:51:59.678645Z',
    ...overrides,
  };
}

beforeEach(() => {
  state.result = { data: null, error: null };
  state.filters = [];
  state.orders = [];
  state.limits = [];
});

describe('resolvePlatformCreds', () => {
  it('filters on provider, owner, status, and the channel base URL', async () => {
    state.result = { data: row(), error: null };

    await resolvePlatformCreds('openai_compatible', 'https://api.kie.ai/v1');

    expect(state.filters).toContain('is:owner_id=null');
    expect(state.filters).toContain('eq:provider=openai_compatible');
    expect(state.filters).toContain('eq:status=active');
    expect(state.filters).toContain('in:base_url=https://api.kie.ai/v1|https://api.kie.ai/v1/');
  });

  it('treats NULL and empty base URLs as the same absence of a URL', async () => {
    state.result = { data: null, error: null };

    await resolvePlatformCreds('anthropic', '').catch(() => undefined);

    expect(state.filters).toContain('or:base_url.is.null,base_url.eq.');
  });

  it('normalizes a trailing slash instead of matching zero rows', async () => {
    state.result = { data: null, error: null };

    await resolvePlatformCreds('openai_compatible', 'https://api.kie.ai/v1/').catch(
      () => undefined,
    );

    expect(state.filters).toContain('in:base_url=https://api.kie.ai/v1|https://api.kie.ai/v1/');
  });

  it('picks the newest row deterministically in the database', async () => {
    state.result = { data: row(), error: null };

    const creds = await resolvePlatformCreds('openai_compatible', 'https://api.kie.ai/v1');

    expect(state.orders).toContain('created_at:{"ascending":false}');
    expect(state.limits).toContain(1);
    expect(creds).toMatchObject({ provider: 'openai_compatible', apiKey: 'decrypted:kie' });
  });

  it("returns the channel's base URL, which decides the endpoint", async () => {
    state.result = { data: row({ base_url: 'https://stored.example/v1' }), error: null };

    const creds = await resolvePlatformCreds('openai_compatible', 'https://api.kie.ai/v1');

    expect(creds.baseUrl).toBe('https://api.kie.ai/v1');
  });

  it('falls back to the decrypted row base URL when the channel has none', async () => {
    state.result = { data: row({ base_url: 'https://stored.example/v1' }), error: null };

    const creds = await resolvePlatformCreds('anthropic', null);

    expect(creds.baseUrl).toBe('https://stored.example/v1');
  });

  it('falls back to ANTHROPIC_API_KEY only for anthropic', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-anthropic-key');
    state.result = { data: null, error: null };

    const anthropic = await resolvePlatformCreds('anthropic', null);
    expect(anthropic).toMatchObject({ provider: 'anthropic', apiKey: 'env-anthropic-key' });

    // No env fallback exists for openai_compatible: there is no well-known key.
    await expect(resolvePlatformCreds('openai_compatible', 'https://api.kie.ai/v1')).rejects.toThrow(
      expect.objectContaining({ code: 'channel_unavailable', status: 503 }),
    );
  });

  it('throws channel_unavailable when nothing matches and no env key exists', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    state.result = { data: null, error: null };

    await expect(resolvePlatformCreds('anthropic', null)).rejects.toThrow(
      expect.objectContaining({ code: 'channel_unavailable', status: 503 }),
    );
  });

  it('surfaces a failed lookup as internal_error', async () => {
    state.result = { data: null, error: { message: 'boom' } };

    await expect(resolvePlatformCreds('anthropic', null)).rejects.toThrow(
      expect.objectContaining({ code: 'internal_error', status: 500 }),
    );
  });
});