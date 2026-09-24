import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  listPublicModels,
  resolveChannel,
  selectChannel,
  selectChannelByModel,
  selectChatRoute,
  selectMediaChannel,
} from '@/lib/ai/channels';
import { routingKey, type Family } from '@/lib/ai/source-types';
import { callWithFallback } from '@/lib/ai/fallback';

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
    modality: 'chat' | 'image' | 'video';
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
  request_price_usd?: string | number | null;
}

function source(overrides: Partial<NonNullable<Row['sources']>> = {}): NonNullable<Row['sources']> {
  return {
    id: 'source-1',
    family: 'claude',
    label: 'Source',
    description: '',
    credit_multiplier: '1.00',
    modality: 'chat',
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
  it('adding Relay preserves Kie defaults while an explicit Relay choice uses its own prices', async () => {
    const kie = row({ id: 'kie-shared', source_id: 'kie-gpt-chat', sources: source({ id: 'kie-gpt-chat', family: 'gpt', is_default: true }), public_model_id: 'shared' });
    const relay = { ...row({ id: 'relay-shared', source_id: 'relay-gpt-chat', priority: -1, sources: source({ id: 'relay-gpt-chat', family: 'gpt', credit_multiplier: '1.5' }), public_model_id: 'shared' }), billing_policy: { origin: 'relay.fast', version: 'v', syncedAt: '2026-09-21', tiers: [{ name: 'standard', rates: { inputPerMTok: .2, outputPerMTok: 1, cachedPerMTok: .02 } }] } };
    state.result = { data: [relay, kie], error: null };
    expect((await selectChannelByModel('shared', 'free'))?.id).toBe('kie-shared');
    expect(await selectChannelByModel('shared', 'free', new Map([['gpt:chat', 'relay-gpt-chat']]))).toMatchObject({ id: 'relay-shared', creditMultiplier: '1.5', rates: { inputPerMTok: .2 } });
  });
  // Keyed on family AND modality: one vendor serves chat, images and video,
  // and a bare family key made a chat choice silently repoint the others.
  const preferences = new Map<string, string>([[routingKey('claude', 'chat'), 'chosen']]);
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

describe('automatic provider fallback', () => {
  const candidate = (id: string, overrides: Partial<Row> = {}) => row({
    id, public_model_id: 'shared', task: 'chat.completions', source_id: id + '-source',
    sources: source({ id: id + '-source', family: 'gpt' }), ...overrides,
  });

  it('tries another eligible provider after a runtime failure and returns its prices', async () => {
    state.result = { data: [
      candidate('primary', { priority: -1, sources: source({ id: 'primary-source', family: 'gpt', is_default: true }) }),
      candidate('backup', { priority: 10, sources: source({ id: 'backup-source', family: 'gpt', credit_multiplier: '1.5' }), input_per_mtok: 3 }),
    ], error: null };
    const route = await selectChatRoute('shared', 'free');
    expect(route?.start.id).toBe('primary');
    const attempt = vi.fn(async (channel: { id: string; creditMultiplier: string }) => {
      if (channel.id === 'primary') throw Object.assign(new Error('unavailable'), { status: 503 });
      return channel.creditMultiplier;
    });
    const result = await callWithFallback(route!.start, route!.resolve, attempt);
    expect(result).toMatchObject({ channelId: 'backup', value: '1.5' });
    expect((await route!.resolve('backup'))?.rates.inputPerMTok).toBe(3);
    expect(route?.holdChannels?.map((channel) => channel.id)).toEqual(['primary', 'backup']);
  });

  it('never includes off, locked, BYOK, other-family or other-modality alternatives', async () => {
    state.result = { data: [
      candidate('primary', { priority: 100 }), candidate('backup'),
      candidate('off', { status: 'off' }), candidate('byok', { is_byok: true }),
      candidate('locked', { min_plan: 'pro' }),
      candidate('source-locked', { sources: source({ family: 'gpt', min_plan: 'pro' }) }),
      candidate('source-off', { sources: source({ family: 'gpt', status: 'off' }) }),
      candidate('other-family', { sources: source({ family: 'claude' }) }),
      candidate('image', { sources: source({ family: 'gpt', modality: 'image' }) }),
    ], error: null };
    const route = await selectChatRoute('shared', 'free');
    expect(route?.start.automaticFallbackIds).toEqual(['backup']);
  });

  it('does not enable sibling retries for a manually selected provider', async () => {
    state.result = { data: [candidate('chosen'), candidate('backup', { priority: 100 })], error: null };
    const route = await selectChatRoute('shared', 'free', new Map([['gpt:chat', 'chosen-source']]));
    expect(route?.start).toMatchObject({ id: 'chosen', fallbackTo: null });
    expect(route?.start.automaticFallbackIds).toBeUndefined();
    const failure = Object.assign(new Error('unavailable'), { status: 503 });
    const attempt = vi.fn(async () => { throw failure; });
    await expect(callWithFallback(route!.start, route!.resolve, attempt)).rejects.toBe(failure);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does not let an image preference disable chat Auto', async () => {
    state.result = { data: [candidate('a'), candidate('b')], error: null };
    const route = await selectChatRoute('shared', 'free', new Map([['gpt:image', 'image-source']]));
    expect(route?.start.automaticFallbackIds).toEqual(['b']);
  });

  it('keeps configured backup links after same-model alternatives', async () => {
    state.result = { data: [candidate('a', { fallback_to: 'configured' }), candidate('b')], error: null };
    const route = await selectChatRoute('shared', 'free');
    expect(route?.start).toMatchObject({ fallbackTo: 'configured', automaticFallbackIds: ['b'] });
    state.result = { data: candidate('configured', { min_plan: 'pro' }), error: null };
    expect(await route!.resolve('configured')).toBeNull();
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

/**
 * The reported bug: with a preference keyed on family alone, one vendor
 * serving chat, images and video shared a single routing decision. The GPT
 * picker offered "kie.ai chat", "kie.ai image" and "kie.ai video" as
 * alternatives to one another, so choosing an image source repointed chat at a
 * gateway with no chat models on it.
 */
describe('modality isolation', () => {
  it('Auto exposes only eligible same-family media alternatives and manual choices do not', async () => {
    const primary = row({ id: 'primary-image', source_id: 'first', task: 'image.generate', pricing_type: 'request', public_model_id: 'image', request_price_usd: .04, sources: source({ id: 'first', family: 'gpt', modality: 'image', is_default: true }) });
    const backup = { ...primary, id: 'backup-image', source_id: 'backup', sources: source({ id: 'backup', family: 'gpt', modality: 'image' }) };
    state.result = { data: [primary, backup, { ...backup, id: 'locked', min_plan: 'pro' }, { ...backup, id: 'video', sources: source({ family: 'gpt', modality: 'video' }) }], error: null };
    expect((await selectMediaChannel('image', 'free', 'image'))?.fallbackChannels?.map((channel) => channel.id)).toEqual(['backup-image']);
    expect((await selectMediaChannel('image', 'free', 'image', new Map([['gpt:image', 'first']])))?.fallbackChannels).toBeUndefined();
  });

  const imageSource = () =>
    source({ id: 'kie-gemini-image', family: 'gemini', modality: 'image', is_default: true });

  const imageRow = () =>
    row({
      id: 'img',
      task: 'image.generate',
      pricing_type: 'request',
      source_id: 'kie-gemini-image',
      sources: imageSource(),
      request_price_usd: '0.04',
    });

  it('ignores a chat preference when resolving an image channel', async () => {
    state.result = { data: [imageRow()], error: null };
    const chatChoice = new Map([[routingKey('gemini', 'chat'), 'some-chat-source']]);
    const picked = await selectMediaChannel('m', 'free', 'image', chatChoice);
    // The chat choice names a source that serves no images. Before the key was
    // widened this filtered every candidate out and fell through unpredictably.
    expect(picked?.id).toBe('img');
  });

  it('honours an image preference that names an image source', async () => {
    state.result = { data: [imageRow()], error: null };
    const imageChoice = new Map([[routingKey('gemini', 'image'), 'kie-gemini-image']]);
    expect((await selectMediaChannel('m', 'free', 'image', imageChoice))?.id).toBe('img');
  });

  it('never serves a request-priced channel to the chat selector', async () => {
    state.result = { data: [imageRow()], error: null };
    expect(await selectChannelByModel('m', 'free', new Map())).toBeNull();
  });
});
