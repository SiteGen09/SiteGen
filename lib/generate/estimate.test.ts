import { describe, expect, it } from 'vitest';

import type { ChannelRow } from '@/lib/ai/fallback';
import { costUsd, creditsForUsage } from '@/lib/ai/pricing';
import { estimateChatHoldCredits } from '@/lib/generate/estimate';

const RATES = { inputPerMTok: 0.5, outputPerMTok: 2, cachedPerMTok: 0.05 };

function channel(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'chat-stub',
    provider: 'openai_compatible',
    baseUrl: 'http://localhost:11435/v1',
    modelId: 'stub-fixture',
    creditMultiplier: '1.00',
    isByok: false,
    status: 'active',
    fallbackTo: null,
    rates: RATES,
    ...overrides,
  };
}

describe('estimateChatHoldCredits', () => {
  it('sizes the hold from message chars and the output ceiling', () => {
    // 4000 chars -> 1000 input tokens; 2000 output tokens.
    const expected = creditsForUsage(
      costUsd(RATES, { inputTokens: 1000, outputTokens: 2000, cachedTokens: 0 }),
      1,
    );
    expect(estimateChatHoldCredits(channel(), 4000, 2000)).toBe(expected);
  });

  it('over-estimates input so settle never exceeds the hold', () => {
    // Real prompts pack more than 4 chars/token, so the char/4 estimate is an
    // upper bound: a same-length real settle can only be smaller.
    const chars = 8000;
    const held = estimateChatHoldCredits(channel(), chars, 1000);
    const realisticInputTokens = 1200; // < ceil(8000/4) = 2000
    const settled = creditsForUsage(
      costUsd(RATES, { inputTokens: realisticInputTokens, outputTokens: 1000, cachedTokens: 0 }),
      1,
    );
    expect(settled).toBeLessThanOrEqual(held);
  });

  it('applies the channel multiplier', () => {
    const single = estimateChatHoldCredits(channel({ creditMultiplier: '1.00' }), 4000, 2000);
    const double = estimateChatHoldCredits(channel({ creditMultiplier: '2.00' }), 4000, 2000);
    expect(double).toBe(single * 2);
  });

  it('holds nothing for a BYOK (zero-multiplier) channel', () => {
    expect(estimateChatHoldCredits(channel({ creditMultiplier: '0', isByok: true }), 4000, 2000)).toBe(0);
  });

  it('rejects a channel with an invalid multiplier', () => {
    expect(() => estimateChatHoldCredits(channel({ creditMultiplier: 'x' }), 4000, 2000)).toThrow(
      expect.objectContaining({ code: 'channel_unavailable', status: 503 }),
    );
  });

  it('treats negative char counts as zero input', () => {
    const zeroInput = creditsForUsage(
      costUsd(RATES, { inputTokens: 0, outputTokens: 500, cachedTokens: 0 }),
      1,
    );
    expect(estimateChatHoldCredits(channel(), -100, 500)).toBe(zeroInput);
  });
});