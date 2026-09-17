import { beforeEach, describe, expect, it, vi } from 'vitest';

import { selectChannel } from '@/lib/ai/channels';

interface QueryResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

const state = vi.hoisted(() => ({
  result: { data: [] as unknown, error: null } as QueryResult,
}));

interface FakeQuery extends PromiseLike<QueryResult> {
  select(): FakeQuery;
  eq(): FakeQuery;
  neq(): FakeQuery;
  gt(): FakeQuery;
  is(): FakeQuery;
  limit(): FakeQuery;
  maybeSingle(): PromiseLike<QueryResult>;
}

function fakeQuery(): FakeQuery {
  const query: FakeQuery = {
    select: () => query,
    eq: () => query,
    neq: () => query,
    gt: () => query,
    is: () => query,
    limit: () => query,
    maybeSingle: () => Promise.resolve(state.result),
    then: (onfulfilled, onrejected) => Promise.resolve(state.result).then(onfulfilled, onrejected),
  };
  return query;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: () => fakeQuery() }),
}));

interface Row {
  id: string;
  label: string;
  task: string;
  provider: string;
  base_url: string | null;
  model_id: string;
  credit_multiplier: string | number;
  status: string;
  min_plan: string;
  fallback_to: string | null;
  priority: number;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'c1',
    label: 'Channel',
    task: 'site.spec',
    provider: 'anthropic',
    base_url: null,
    model_id: 'claude-3-5-haiku-20241022',
    credit_multiplier: '1.00',
    status: 'active',
    min_plan: 'free',
    fallback_to: null,
    priority: 0,
    ...overrides,
  };
}

describe('selectChannel', () => {
  beforeEach(() => {
    state.result = { data: [], error: null };
  });

  it('returns null when no channel matches the plan minimum', async () => {
    state.result = {
      data: [row({ id: 'strong', min_plan: 'pro', priority: 10 })],
      error: null,
    };
    expect(await selectChannel('site.spec', 'free')).toBeNull();
  });

  it('honors min_plan: a pro channel is selectable by a pro user', async () => {
    state.result = {
      data: [row({ id: 'strong', min_plan: 'pro', priority: 10 })],
      error: null,
    };
    const channel = await selectChannel('site.spec', 'pro');
    expect(channel?.id).toBe('strong');
  });

  it('prefers the highest priority among eligible channels', async () => {
    state.result = {
      data: [
        row({ id: 'cheap', priority: 0 }),
        row({ id: 'strong', priority: 10, min_plan: 'starter' }),
      ],
      error: null,
    };
    const channel = await selectChannel('site.spec', 'pro');
    expect(channel?.id).toBe('strong');
  });

  it('prefers active over degraded when priority ties', async () => {
    state.result = {
      data: [
        row({ id: 'degraded', status: 'degraded', priority: 5 }),
        row({ id: 'healthy', status: 'active', priority: 5 }),
      ],
      error: null,
    };
    const channel = await selectChannel('site.spec', 'free');
    expect(channel?.id).toBe('healthy');
  });

  it('carries the credit multiplier through as a string', async () => {
    state.result = { data: [row({ id: 'cheap', credit_multiplier: 1.2 })], error: null };
    const channel = await selectChannel('site.spec', 'free');
    expect(channel?.creditMultiplier).toBe('1.2');
  });

  it('throws when the channel query errors', async () => {
    state.result = { data: null, error: { message: 'boom' } };
    await expect(selectChannel('site.spec', 'free')).rejects.toThrow(/channel lookup failed/);
  });
});
