import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listPublicModels,
  resolveChannel,
  selectChannel,
  selectChannelByModel,
} from '@/lib/ai/channels';
import type { Family } from '@/lib/ai/source-types';

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
  source_id: string | null;
  sources: {
    id: string;
    family: Family;
    label: string;
    description: string;
    credit_multiplier: string | number;
    status: string;
    min_plan: string;
    is_default: boolean;
  } | null;
  is_byok: boolean;
  pricing_type: 'token' | 'request';
  status: string;
  min_plan: string;
  fallback_to: string | null;
  priority: number;
  input_per_mtok: string | number;
  output_per_mtok: string | number;
  cached_per_mtok: string | number;
  public_model_id: string | null;
}

function source(overrides: Partial<NonNullable<Row['sources']>> = {}): NonNullable<Row['sources']> {
  return {
    id: 'source-1',
    family: 'claude',
    label: 'Source',
    description: '',
    credit_multiplier: '1.00',
    status: 'active',
    min_plan: 'free',
    is_default: false,
    ...overrides,
  };
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'c1',
    label: 'Channel',
    task: 'site.spec',
    provider: 'anthropic',
    base_url: null,
    model_id: 'claude-3-5-haiku-20241022',
    source_id: 'source-1',
    sources: source(),
    is_byok: false,
    pricing_type: 'token',
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

  it('ranks the source status before the id tie-breaker in both selectors', async () => {
    state.result = {
      data: [
        row({
          id: 'a-degraded-source',
          public_model_id: 'shared-model',
          priority: 5,
          source_id: 'degraded-source',
          sources: source({ id: 'degraded-source', status: 'degraded' }),
        }),
        row({ id: 'z-healthy-source', public_model_id: 'shared-model', priority: 5 }),
      ],
      error: null,
    };
    expect(await selectChannel('site.spec', 'free')).toMatchObject({
      id: 'z-healthy-source',
      status: 'active',
    });
    expect(await selectChannelByModel('shared-model', 'free')).toMatchObject({
      id: 'z-healthy-source',
      status: 'active',
    });
  });

  it.each([
    ['active', 'degraded'],
    ['degraded', 'active'],
    ['degraded', 'degraded'],
  ])(
    'returns degraded for channel %s and source %s from selection and fallback lookup',
    async (channelStatus, sourceStatus) => {
      const candidate = row({ status: channelStatus, sources: source({ status: sourceStatus }) });
      state.result = { data: [candidate], error: null };
      expect((await selectChannel('site.spec', 'free'))?.status).toBe('degraded');
      state.result = { data: candidate, error: null };
      expect((await resolveChannel(candidate.id))?.status).toBe('degraded');
    },
  );

  it('carries the credit multiplier through as a string', async () => {
    state.result = {
      data: [row({ id: 'cheap', sources: source({ credit_multiplier: 1.2 }) })],
      error: null,
    };
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

// A choice is best effort and cannot bypass source eligibility.
describe('source cascade', () => {
  const preferences = new Map<'claude', string>([['claude', 'chosen']]);
  const chosen = () =>
    row({
      id: 'preferred',
      source_id: 'chosen',
      sources: source({ id: 'chosen', credit_multiplier: '1.85' }),
    });
  const standard = () =>
    row({ id: 'default', priority: 10, sources: source({ is_default: true }) });
  it('prefers choice over default and priority', async () => {
    state.result = { data: [chosen(), standard()], error: null };
    expect(await selectChannelByModel('m', 'free', preferences)).toMatchObject({
      id: 'preferred',
      creditMultiplier: '1.85',
    });
  });
  it('preserves the preference cascade even when the chosen source is degraded', async () => {
    const preferred = chosen();
    preferred.sources = source({ id: 'chosen', status: 'degraded' });
    state.result = { data: [preferred, standard()], error: null };
    expect(await selectChannelByModel('m', 'free', preferences)).toMatchObject({
      id: 'preferred',
      status: 'degraded',
    });
  });
  it('falls back to default when choice lacks model coverage', async () => {
    state.result = { data: [standard(), row({ priority: 100 })], error: null };
    expect((await selectChannelByModel('m', 'free', preferences))?.id).toBe('default');
  });
  it.each(['off', 'locked'])('excludes an %s source', async (reason) => {
    const unavailable = chosen();
    unavailable.sources = source({
      status: reason === 'off' ? 'off' : 'active',
      min_plan: reason === 'locked' ? 'pro' : 'free',
    });
    state.result = { data: [unavailable, standard()], error: null };
    expect((await selectChannelByModel('m', 'free', preferences))?.id).toBe('default');
  });
  it('uses any eligible source without a covering default', async () => {
    state.result = { data: [row({ id: 'any', priority: 20 }), row()], error: null };
    expect((await selectChannelByModel('m', 'free', preferences))?.id).toBe('any');
  });
  it('deduplicates model names', async () => {
    state.result = {
      data: [row({ public_model_id: 'm' }), row({ id: 'other', public_model_id: 'm' })],
      error: null,
    };
    expect(await listPublicModels('free', preferences)).toEqual(['m']);
  });
});

// A catalog unit must never be interpreted as a different billing unit.
describe('request-priced catalog entries', () => {
  it('excludes them from token dispatch, model enumeration and fallback', async () => {
    const requestRow = row({ pricing_type: 'request', public_model_id: 'request-model' });
    state.result = { data: [requestRow], error: null };
    expect(await selectChannel('site.spec', 'pro')).toBeNull();
    expect(await selectChannelByModel('request-model', 'pro')).toBeNull();
    expect(await listPublicModels('pro')).toEqual([]);
    state.result = { data: requestRow, error: null };
    expect(await resolveChannel(requestRow.id)).toBeNull();
  });
});
