import { describe, expect, it } from 'vitest';

import {
  consumerPrice,
  keyQuotaNotice,
  lowBalanceNotice,
  modelsAddedNotice,
  modelsRemovedNotice,
  priceChanged,
  priceChangeNotice,
  upstreamAlertNotice,
  usd,
  type ConsumerPrice,
} from './messages';

const tokenRow = (input: number, output: number) => ({
  pricing_type: 'token',
  input_per_mtok: String(input),
  output_per_mtok: String(output),
  billing_policy: { origin: 'relay.fast', version: 'v', syncedAt: 'x', tiers: [{ name: 'standard', rates: { inputPerMTok: input, outputPerMTok: output, cachedPerMTok: input / 10 } }] },
});

describe('consumerPrice', () => {
  it('prices tokens at the provider rate times the markup', () => {
    const price = consumerPrice(tokenRow(.036, .18), 1.5);
    expect(price).toMatchObject({ kind: 'token' });
    expect(price?.kind === 'token' && [price.input, price.output]).toEqual([expect.closeTo(.054, 10), expect.closeTo(.27, 10)]);
  });

  it('falls back to the columns without a billing policy', () => {
    expect(consumerPrice({ pricing_type: 'token', input_per_mtok: '2', output_per_mtok: '8' }, 2)).toEqual({ kind: 'token', input: 4, output: 16 });
  });

  it('prices request channels per job', () => {
    expect(consumerPrice({ pricing_type: 'request', request_price_usd: '0.03' }, 1.5)).toEqual({ kind: 'request', perJob: .045 });
  });

  it('returns null for a snapshot without a price', () => {
    expect(consumerPrice({ pricing_type: 'token' }, 1)).toBeNull();
  });
});

describe('price change notices', () => {
  type TokenPrice = Extract<ConsumerPrice, { kind: 'token' }>;
  const before = consumerPrice(tokenRow(.036, .18), 1.5) as TokenPrice;
  const after = consumerPrice(tokenRow(.2232, 1.116), 1.5) as TokenPrice;

  it('ignores rounding noise', () => {
    expect(priceChanged(before, { ...before, input: before.input * 1.001 })).toBe(false);
    expect(priceChanged(before, after)).toBe(true);
  });

  it('shows old and new consumer prices and flags a large increase', () => {
    const notice = priceChangeNotice([{ model: 'claude-opus-5-5', provider: 'Provider A', before, after }]);
    expect(notice.title).toBe('Price increase: claude-opus-5-5');
    expect(notice.body).toContain('claude-opus-5-5 (Provider A): input $0.054 → $0.3348, output $0.27 → $1.674 per 1M tokens');
    expect(notice).toMatchObject({ link: '/prices', important: true });
  });

  it('summarises mixed changes across models and caps the list', () => {
    const changes = Array.from({ length: 30 }, (_, index) => ({
      model: `m-${String(index).padStart(2, '0')}`, provider: 'Provider A',
      before, after: index % 2 ? after : { ...before, input: before.input / 2, output: before.output / 2 },
    }));
    const notice = priceChangeNotice(changes);
    expect(notice.title).toBe('Price changes for 30 models');
    expect(notice.body).toContain('…and 5 more.');
  });

  it('does not flag a decrease as important', () => {
    expect(priceChangeNotice([{ model: 'grok-4.6', provider: 'Provider A', before: after, after: before }]))
      .toMatchObject({ title: 'Price decrease: grok-4.6', important: false });
  });
});

describe('model notices', () => {
  it('announces one model with its plan', () => {
    expect(modelsAddedNotice([{ model: 'gpt-6-luna', modality: 'chat', planLabel: 'Pro' }]))
      .toMatchObject({ title: 'New model: gpt-6-luna', body: expect.stringContaining('gpt-6-luna (Pro plan and above) is now available'), important: false });
  });

  it('lists several models in one notice', () => {
    const notice = modelsAddedNotice([
      { model: 'gpt-6-luna', modality: 'chat', planLabel: null },
      { model: 'img-2', modality: 'image', planLabel: null },
    ]);
    expect(notice.title).toBe('2 new models available');
    expect(notice.body).toContain('• img-2 (image model)');
  });

  it('marks a removal important', () => {
    expect(modelsRemovedNotice([{ model: 'old', modality: 'chat', planLabel: null }])).toMatchObject({ title: 'Model removed: old', important: true });
  });
});

describe('account notices', () => {
  it('states the balance in dollars', () => {
    expect(lowBalanceNotice(4_200).body).toContain('$0.42');
    expect(lowBalanceNotice(5_000).body).toContain('$0.50');
  });

  it('distinguishes a key near its limit from one that reached it', () => {
    expect(keyQuotaNotice('ci', 8_500, 10_000, false)).toMatchObject({ title: 'API key "ci" has used 80% of its limit', important: false });
    expect(keyQuotaNotice('ci', 10_000, 10_000, true)).toMatchObject({ title: 'API key "ci" reached its spending limit', important: true });
  });
});

describe('usd', () => {
  it('keeps sub-cent rates readable', () => {
    expect(usd(.0204)).toBe('$0.0204');
    expect(usd(.33482142857)).toBe('$0.3348');
    expect(usd(12.3456)).toBe('$12.35');
    expect(usd(1.674)).toBe('$1.674');
    expect(usd(0)).toBe('$0');
  });
});

describe('upstream alert', () => {
  it('states the failure rate, counts and top errors for admins', () => {
    const notice = upstreamAlertNotice({ provider: 'relay.fast', family: 'gpt', failed: 6, succeeded: 4, windowMinutes: 10, topErrors: ['http_503 (6)'] });
    expect(notice.title).toBe('relay.fast gpt failing: 60% of attempts in the last 10 minutes');
    expect(notice.body).toContain('6 of 10 attempts');
    expect(notice.body).toContain('Most common: http_503 (6).');
    expect(notice).toMatchObject({ link: '/admin/sources', important: true });
  });
});
