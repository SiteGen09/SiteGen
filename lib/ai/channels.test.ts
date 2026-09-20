import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listPublicModels, selectChannel, selectChannelByModel } from '@/lib/ai/channels';

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
  not(): FakeQuery;
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
    not: () => query,
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
  input_per_mtok: string | number;
  output_per_mtok: string | number;
  cached_per_mtok: string | number;
  public_model_id: string | null;
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
    input_per_mtok: '0.8',
    output_per_mtok: '4',
    cached_per_mtok: '0.08',
    public_model_id: null,
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

describe('selectChannelByModel', () => {
  beforeEach(() => {
    state.result = { data: [], error: null };
  });

  it('resolves the channel a caller addressed by public model name', async () => {
    state.result = {
      data: [row({ id: 'chat-stub', public_model_id: 'stub-chat', task: 'chat.completions' })],
      error: null,
    };
    const channel = await selectChannelByModel('stub-chat', 'free');
    expect(channel?.id).toBe('chat-stub');
  });

  it('returns null for an unknown model name', async () => {
    state.result = { data: [], error: null };
    expect(await selectChannelByModel('nope', 'pro')).toBeNull();
  });

  it('returns null when the plan cannot reach the model', async () => {
    // Same null as an unknown name: the caller must not be able to tell
    // "no such model" from "your plan cannot use this model".
    state.result = {
      data: [row({ id: 'chat-pro', public_model_id: 'pro-chat', min_plan: 'pro' })],
      error: null,
    };
    expect(await selectChannelByModel('pro-chat', 'free')).toBeNull();
  });

  it('ranks eligible channels with the shared best-of rule', async () => {
    state.result = {
      data: [
        row({ id: 'low', public_model_id: 'm', priority: 1 }),
        row({ id: 'high', public_model_id: 'm', priority: 9 }),
      ],
      error: null,
    };
    expect((await selectChannelByModel('m', 'free'))?.id).toBe('high');
  });

  it('throws when the model lookup errors', async () => {
    state.result = { data: null, error: { message: 'boom' } };
    await expect(selectChannelByModel('m', 'free')).rejects.toThrow(/channel model lookup failed/);
  });
});

describe('listPublicModels', () => {
  beforeEach(() => {
    state.result = { data: [], error: null };
  });

  it('lists only names the plan may reach, sorted', async () => {
    state.result = {
      data: [
        row({ id: 'b', public_model_id: 'beta' }),
        row({ id: 'a', public_model_id: 'alpha' }),
        row({ id: 'p', public_model_id: 'premium', min_plan: 'pro' }),
      ],
      error: null,
    };
    expect(await listPublicModels('free')).toEqual(['alpha', 'beta']);
  });

  it('omits channels with no public name', async () => {
    state.result = {
      data: [row({ id: 'spec', public_model_id: null })],
      error: null,
    };
    expect(await listPublicModels('pro')).toEqual([]);
  });
});
