import { describe, expect, it } from 'vitest';
import { parseRelayExpression, relayChannels } from './relay-catalog';
import { policyRates, type BillingPolicy } from './billing-policy';
import { costUsd, creditsForUsage } from './pricing';

const expression = 'len <= 272000 ? tier("short_context", p * 10 + c * 50 + cr * 1 + cc * 12.5) : tier("long_context", p * 20 + c * 75 + cr * 2 + cc * 25)';
const policy = { origin: 'relay.fast', version: 'test', syncedAt: '2026-09-21', ...parseRelayExpression(expression, 0.02) } satisfies BillingPolicy;

describe('Relay billing', () => {
  it('charges discounted rates and applies the platform markup once', () => {
    const cost = costUsd(policyRates(policy), { inputTokens: 100000, outputTokens: 10000, cachedTokens: 0 });
    expect(cost).toBeCloseTo(0.03);
    expect(creditsForUsage(cost, 1.5)).toBe(450);
  });
  it('uses total prompt including cache reads to choose the whole-request tier', () => {
    const rates = policyRates(policy);
    expect(costUsd(rates, { inputTokens: 0, cachedTokens: 272000, outputTokens: 0 })).toBeCloseTo(0.00544);
    expect(costUsd(rates, { inputTokens: 1, cachedTokens: 272000, outputTokens: 0 })).toBeCloseTo(0.0108804);
  });
  it('separates cache writes without double charging and preserves legacy rates', () => {
    const usage = { inputTokens: 100000, cachedTokens: 0, outputTokens: 0, cacheWriteTokens: 90000 };
    expect(costUsd(policyRates(policy), usage)).toBeCloseTo(0.0245);
    expect(costUsd({ inputPerMTok: 0.2, outputPerMTok: 1, cachedPerMTok: 0.02 }, usage)).toBeCloseTo(0.02);
  });
  it('selects the correct side of each UTC peak boundary', () => {
    const timed = { ...policy, contextThreshold: undefined, peakUtcHours: [[1, 4], [6, 10]], tiers: [{ name: 'peak', rates: { inputPerMTok: 0.015, outputPerMTok: 0.06, cachedPerMTok: 0.0003 } }, { name: 'off_peak', rates: { inputPerMTok: 0.0075, outputPerMTok: 0.03, cachedPerMTok: 0.00015 } }] } as BillingPolicy;
    for (const [hour, price] of [[0, .0075], [1, .015], [3, .015], [4, .0075], [6, .015], [10, .0075]]) {
      expect(policyRates(timed, new Date(Date.UTC(2026, 8, 21, hour))).inputPerMTok).toBe(price);
    }
  });
  it('refuses arbitrary expressions rather than executing them', () => {
    expect(() => parseRelayExpression('fetch("https://bad.example")', 1)).toThrow();
    expect(() => parseRelayExpression('len > 1 ? tier("a", p * 1 + c * 1) : tier("b", p * 2 + c * 2)', 1)).toThrow();
  });
  it('applies model and group multipliers without importing markup into rates', () => {
    const [channel] = relayChannels({ success: true, pricing_version: 'v', vendors: [{ id: 1, name: 'OpenAI' }], data: [{ model_name: 'gpt-5.6-luna', quota_type: 0, model_ratio: .1, completion_ratio: 6, model_price: 0, billing_multiplier: 4, group_ratio: { default: .02 }, enable_groups: ['default'], supported_endpoint_types: ['openai'], vendor_id: 1 }] });
    expect(channel!.input_per_mtok).toBe(.016);
    expect(channel!.output_per_mtok).toBeCloseTo(.096);
    expect(channel!.source_id).toBe('relay-gpt-chat');
  });
});
