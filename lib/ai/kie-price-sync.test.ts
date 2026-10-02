import { describe, expect, it } from 'vitest';

import { kieCatalogRows, parseChat, type KieModel } from './kie-catalog';
import { planKieRepricing, type StoredKieChannel } from './kie-price-sync';

const chatModel = (model: string, desc: string): KieModel => ({ model, title: model, provider: 'OpenAI', taskType: ['Chat'], pricingDesc: desc });
const videoModel = (model: string, desc: string): KieModel => ({ model, title: model, provider: 'Kling', taskType: ['Text to Video'], pricingDesc: desc });

const stored = (overrides: Partial<StoredKieChannel>): StoredKieChannel => ({
  id: 'kie-chat-gpt-5-6-sol', model_id: 'gpt-5.6-sol', task: 'chat.completions', status: 'active', pricing_type: 'token',
  input_per_mtok: 1.4, output_per_mtok: 8.4, cached_per_mtok: 0, request_price_usd: null, billing_policy: null,
  ...overrides,
});

const SOL = 'Input 280 credits / 1M tokens (≈ $1.40); Output 1680 credits / 1M tokens (≈ $8.40); Cached input 28 credits / 1M tokens (≈ $0.14)';

describe('parseChat', () => {
  it('reads the published cache price', () => {
    expect(parseChat(SOL)).toEqual({ inputPerMTok: 1.4, outputPerMTok: 8.4, cachedPerMTok: .14 });
  });

  it('bills cache reads at the input price when none is published', () => {
    expect(parseChat('Input 100 credits / 1M tokens (≈ $0.50); Output 700 credits / 1M tokens (≈ $3.50)')?.cachedPerMTok).toBe(.5);
  });
});

describe('planKieRepricing', () => {
  const catalog = kieCatalogRows([chatModel('gpt-5.6-sol', SOL), videoModel('kling/v3', 'From 40 credits ($0.20) up to 160 credits ($0.80) per video')]);

  it('fills a missing cache price without touching matching rates', () => {
    const plan = planKieRepricing([stored({})], catalog);
    expect(plan.updates).toEqual([expect.objectContaining({ id: 'kie-chat-gpt-5-6-sol', from: [1.4, 8.4, 0], to: [1.4, 8.4, .14] })]);
  });

  it('leaves a current price alone', () => {
    expect(planKieRepricing([stored({ cached_per_mtok: .14 })], catalog)).toMatchObject({ updates: [], unchanged: 1 });
  });

  it('matches by model id when the channel id differs', () => {
    const plan = planKieRepricing([stored({ id: 'kie-responses-gpt-5-6-sol', input_per_mtok: 1.2 })], catalog);
    expect(plan.updates[0]).toMatchObject({ id: 'kie-responses-gpt-5-6-sol', to: [1.4, 8.4, .14] });
  });

  it('holds an implausible move for review instead of applying it', () => {
    const plan = planKieRepricing([stored({ input_per_mtok: .1, cached_per_mtok: .14 })], catalog);
    expect(plan.updates).toEqual([]);
    expect(plan.review[0]?.reason).toMatch(/implausible/);
  });

  it('reports active channels kie.ai no longer lists, but not ones already off', () => {
    const plan = planKieRepricing([
      stored({ id: 'kie-chat-gone', model_id: 'gone' }),
      stored({ id: 'kie-chat-old', model_id: 'old', status: 'off' }),
    ], catalog);
    expect(plan.missing).toEqual(['kie-chat-gone']);
  });

  it('reprices a media ceiling', () => {
    const plan = planKieRepricing([stored({ id: 'kie-video-kling-v3', model_id: 'kling/v3', task: 'video.generate', pricing_type: 'request', request_price_usd: .6 })], catalog);
    expect(plan.updates[0]).toMatchObject({ kind: 'video', from: [.6], to: [.8] });
  });

  it('keeps tiered policies out of automatic sync', () => {
    const plan = planKieRepricing([stored({
      billing_policy: {
        origin: 'kie.ai', version: 'v', syncedAt: 'x', contextThreshold: 200000,
        tiers: [{ name: 'short', rates: { inputPerMTok: 1, outputPerMTok: 2, cachedPerMTok: .1 } }, { name: 'long', rates: { inputPerMTok: 2, outputPerMTok: 4, cachedPerMTok: .2 } }],
      },
    })], catalog);
    expect(plan.review[0]?.reason).toMatch(/tiered/);
  });
});
