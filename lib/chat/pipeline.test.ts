import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelRow } from '@/lib/ai/fallback';
import { prepareCall, resolveChannelAndCreds, settleCall } from './pipeline';

const state = vi.hoisted(() => ({
  select: vi.fn(), credential: vi.fn(), hold: vi.fn(), platform: vi.fn(), settle: vi.fn(),
  upsert: vi.fn(async () => ({ error: null })),
}));
vi.mock('@/lib/ai/channels', () => ({ selectChatRoute: state.select }));
vi.mock('@/lib/ai/sources', () => ({ loadRoutingPreferences: async () => new Map() }));
vi.mock('@/lib/generate/credentials', () => ({ getUserCredential: state.credential }));
vi.mock('@/lib/admin/credentials', () => ({ resolvePlatformCreds: state.platform }));
vi.mock('@/lib/generate/ledger', () => ({ holdCredits: state.hold, settleCredits: state.settle }));
vi.mock('@/lib/guardrails/runtime', () => ({ enforceLocalPolicy: async () => undefined }));
vi.mock('@/lib/moderation/check', () => ({ checkContent: async () => ({ flagged: false }) }));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: () => ({
    select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: { plan_key: 'free' }, error: null }),
    }) }),
    upsert: state.upsert,
  }) }),
}));

const primary: ChannelRow = {
  id: 'primary', provider: 'openai_compatible', baseUrl: 'https://primary.example/v1',
  modelId: 'model', isByok: false, status: 'active', creditMultiplier: '1',
  fallbackTo: 'configured', automaticRouting: true, automaticFallbackIds: ['backup'],
  rates: { inputPerMTok: 1, outputPerMTok: 2, cachedPerMTok: .1 },
};
const backup: ChannelRow = {
  ...primary, id: 'backup', baseUrl: 'https://backup.example/v1', creditMultiplier: '1.5',
  rates: { inputPerMTok: 3, outputPerMTok: 8, cachedPerMTok: .3 },
};
const input = {
  requestId: 'test-request', auth: { ownerId: 'owner', apiKeyId: null },
  model: 'model', messages: [{ role: 'user' as const, content: 'test' }],
  maxOutputTokens: 1000, maxOutputField: 'max_tokens',
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.select.mockResolvedValue({
    start: primary, holdChannels: [primary, backup], resolve: async () => backup,
  });
  state.credential.mockResolvedValue(null);
  state.hold.mockResolvedValue({ success: true });
});

describe('routing credit reservations', () => {
  it('reserves enough for the more expensive Auto provider in a single hold', async () => {
    const result = await prepareCall(input);
    expect(result).toMatchObject({ ok: true, held: true });
    // 1 input token at $3/M + 1000 output tokens at $8/M, with a 1.5 multiplier.
    expect(state.hold).toHaveBeenCalledExactlyOnceWith('owner', 'test-request', 121, 'primary');
  });

  it('keeps a personal-key request free of platform holds and fallback', async () => {
    const personalKey = { provider: 'openai_compatible', apiKey: 'personal-test-key', baseUrl: 'https://personal.example/v1' };
    state.credential.mockResolvedValue(personalKey);
    const result = await prepareCall(input);
    expect(result).toMatchObject({ ok: true, held: false });
    expect(state.hold).not.toHaveBeenCalled();
    if (!result.ok) throw new Error('unexpected preflight failure');
    expect(result.resolved.start).toMatchObject({
      isByok: true, creditMultiplier: '0', fallbackTo: null,
      automaticRouting: false, automaticFallbackIds: [],
    });
    expect(result.resolved.holdChannels).toBeUndefined();
    expect(await result.resolved.resolve('backup')).toBeNull();
    expect(await result.resolved.buildCreds(result.resolved.start)).toBe(personalKey);
    expect(state.platform).not.toHaveBeenCalled();
  });

  it('resolves platform credentials separately for the actual serving provider', async () => {
    const result = await resolveChannelAndCreds('model', 'owner', 'free');
    await result!.buildCreds(backup);
    expect(state.platform).toHaveBeenCalledExactlyOnceWith('openai_compatible', 'https://backup.example/v1');
  });
});

describe('usage source for personal keys', () => {
  const settle = (byok: boolean) => settleCall({
    requestId: 'test-request', auth: input.auth, log: input.log, channelId: 'primary',
    held: !byok, multiplier: byok ? 0 : 1, byok, rates: primary.rates,
    usage: { inputTokens: 1000, outputTokens: 1000, cachedTokens: 0 }, latencyMs: 10,
  });

  it('marks a personal-key call as BYOK so its provider bill is not counted as platform cost', async () => {
    await settle(true);
    expect(state.settle).not.toHaveBeenCalled();
    // 1000 input at $1/M + 1000 output at $2/M, charged nothing.
    expect(state.upsert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      source_id: null, source_label: 'BYOK', credits_charged: 0, cost_usd: 0.003, status: 'ok',
    }));
  });

  it('leaves a platform call to the channel source snapshot', async () => {
    await settle(false);
    expect(state.settle).toHaveBeenCalledOnce();
    const row = (state.upsert.mock.calls[0] as unknown[])[0];
    expect(row).toMatchObject({ credits_charged: 30, cost_usd: 0.003 });
    expect(row).not.toHaveProperty('source_label');
    expect(row).not.toHaveProperty('source_id');
  });
});
