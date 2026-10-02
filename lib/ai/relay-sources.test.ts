import { describe, expect, it } from 'vitest';

import { costUsd } from '@/lib/ai/pricing';
import { policyRates, publicBillingPolicy, scaleTiers, type BillingPolicy } from '@/lib/ai/billing-policy';
import { relayChannels } from '@/lib/ai/relay-catalog';
import {
  activeSources,
  mergeObservations,
  relayProfileSchema,
  repricedPolicy,
  repriceSource,
  type RelayLogItem,
} from '@/lib/ai/relay-sources';

const source = (family: string, tier: string, label: string, n: number, d: number) => ({
  family, tier, label, status: 'active', unit_price_numerator: n, unit_price_denominator: d,
});
const gpt = [
  source('gpt', 'gpt-standard', 'GPT Team/Plus', 1, 50),
  source('gpt', 'gpt-plus-pro', 'GPT Plus/Pro', 17, 500),
  source('gpt', 'gpt-pro-enterprise', 'GPT Pro/Enterprise', 27, 500),
];
const claude = [source('claude', 'kiro', 'Claude Kiro', 9, 250), source('claude', 'max', 'Claude Max', 25, 112)];
const grok = [source('grok', 'grok-free', 'Grok Free', 1, 60), source('grok', 'grok-super', 'Grok Heavy', 1, 30)];

/** Shaped like Relay's GET /api/routing/profile on 2026-09-27. */
function profile(tiers: { gpt?: string; claude?: string; grok?: string; maxPaths?: string[] } = {}) {
  return relayProfileSchema.parse({
    success: true,
    data: {
      gpt_routing: { tier: tiers.gpt ?? 'gpt-plus-pro', sources: gpt },
      claude_routing: { tier: tiers.claude ?? 'max', sources: claude, max_supported_paths: tiers.maxPaths ?? ['/v1/messages', '/v1/chat/completions'] },
      grok_routing: { tier: tiers.grok ?? 'grok-free', sources: grok },
      sources: [...gpt, ...claude, ...grok, source('gemini', 'gemini-standard', 'Gemini Standard', 1, 16), source('gpt-image', 'gpt-image-standard', 'GPT Images', 1, 50)],
    },
  }).data;
}

function catalogModel(name: string, vendor: number, groupRatio: number, billingMultiplier?: number) {
  return {
    success: true, pricing_version: 'v', vendors: [{ id: 1, name: 'OpenAI' }, { id: 3, name: 'Anthropic' }, { id: 4, name: 'xAI' }],
    data: [{
      model_name: name, quota_type: 0, model_ratio: 1, completion_ratio: 5, cache_ratio: .1, model_price: 0,
      billing_multiplier: billingMultiplier, group_ratio: { default: groupRatio }, enable_groups: ['default'],
      supported_endpoint_types: ['openai'], vendor_id: vendor,
    }],
  };
}

function importedPolicy(catalog: unknown): BillingPolicy {
  return relayChannels(catalog)[0]!.billing_policy;
}

const logItem = (model: string, tier: string, groupRatio: number, at: number): RelayLogItem => ({
  model_name: model, created_at: at, other: JSON.stringify({ routing_tier: tier, group_ratio: groupRatio }),
});
const now = new Date('2026-09-27T02:00:00Z');
const nowSeconds = now.getTime() / 1000;

describe('activeSources', () => {
  it('prices each family at the selected source', () => {
    const sources = activeSources(profile(), '/v1/chat/completions');
    expect(sources.get('gpt')).toEqual({ tier: 'gpt-plus-pro', label: 'GPT Plus/Pro', unitPrice: 17 / 500 });
    expect(sources.get('claude')?.tier).toBe('max');
    expect(sources.get('grok')?.unitPrice).toBe(1 / 60);
    expect(sources.get('gemini')?.unitPrice).toBe(1 / 16);
  });

  it('keeps Claude on Kiro for a path Claude Max does not serve', () => {
    expect(activeSources(profile({ maxPaths: ['/v1/messages'] }), '/v1/chat/completions').get('claude')?.tier).toBe('kiro');
  });

  it('refuses a selection missing from the source list', () => {
    expect(() => activeSources(profile({ gpt: 'gpt-new' }), '/v1/chat/completions')).toThrow(/gpt-new/);
  });

  it('prices a family with several unselected sources at its cheapest, keeping the rest as fallbacks', () => {
    const sources = activeSources(multiSourceProfile(), '/v1/chat/completions');
    // Reserve ties Standard on price; the tie goes to Standard.
    expect(sources.get('gemini')).toEqual({
      tier: 'gemini-standard', label: 'Gemini Standard', unitPrice: 1 / 16,
      fallbacks: { 'gemini-reserve': 'Gemini Reserve', 'gemini-lastresort': 'Gemini Last Resort' },
    });
    expect(sources.get('kimi')).toMatchObject({ tier: 'kimi-opencode', unitPrice: 1 / 40 });
    expect(sources.get('gpt')).not.toHaveProperty('fallbacks');
  });
});

/** Shaped like Relay's GET /api/routing/profile on 2026-09-30, when fixed families gained fallback sources. */
function multiSourceProfile() {
  const base = profile();
  return {
    ...base,
    sources: [
      ...base.sources,
      source('gemini', 'gemini-lastresort', 'Gemini Last Resort', 1, 8),
      source('gemini', 'gemini-reserve', 'Gemini Reserve', 1, 16),
      source('kimi', 'kimi-lastresort', 'Kimi Last Resort', 1, 5),
      source('kimi', 'kimi-opencode', 'Kimi', 1, 40),
      source('kimi', 'kimi-reserve', 'Kimi Reserve', 1, 10),
    ],
  };
}

describe('repriceSource', () => {
  it('scales the catalog default to the selected source', () => {
    const policy = importedPolicy(catalogModel('gpt-6-sol', 1, .02));
    const sp = policy.sourcePricing!;
    expect(sp).toMatchObject({ relayFamily: 'gpt', factor: .02, scale: 1, tier: null });
    const next = repriceSource(sp, activeSources(profile(), '/v1/chat/completions').get('gpt')!, undefined);
    expect(next).toMatchObject({ scale: 1.7, tier: 'gpt-plus-pro', label: 'GPT Plus/Pro' });
    expect(policyRates(repricedPolicy(policy, next)).inputPerMTok).toBe(.068);
  });

  it('scales down when the catalog default is a pricier source (Grok Heavy)', () => {
    const sp = importedPolicy(catalogModel('grok-4.6', 4, 1 / 30)).sourcePricing!;
    expect(repriceSource(sp, activeSources(profile(), '/v1/chat/completions').get('grok')!, undefined).scale).toBe(.5);
  });

  it('keeps the billing multiplier outside the source ratio', () => {
    const sp = importedPolicy(catalogModel('gpt-5.6-luna', 1, .02, 4)).sourcePricing!;
    expect(sp).toMatchObject({ factor: .08, billingMultiplier: 4 });
    expect(repriceSource(sp, activeSources(profile(), '/v1/chat/completions').get('gpt')!, undefined).scale).toBe(1.7);
  });

  it('charges what Relay billed when that is above the listed price', () => {
    const sp = importedPolicy(catalogModel('gpt-6-sol', 1, .02)).sourcePricing!;
    const active = activeSources(profile({ gpt: 'gpt-pro-enterprise' }), '/v1/chat/completions').get('gpt')!;
    const billed = { tier: 'gpt-pro-enterprise', groupRatio: .062, at: nowSeconds };
    expect(repriceSource(sp, active, billed).scale).toBe(3.1);
    // A billed ratio from a different source says nothing about this one.
    expect(repriceSource(sp, active, { ...billed, tier: 'gpt-standard' }).scale).toBe(2.7);
  });

  it('raises a multi-source family to a fallback Relay billed, and names that source', () => {
    const sp = { relayFamily: 'gemini', factor: 1 / 16, billingMultiplier: 1, baseTiers: [], scale: 1, tier: null, label: null };
    const active = activeSources(multiSourceProfile(), '/v1/chat/completions').get('gemini')!;
    expect(repriceSource(sp, active, undefined)).toMatchObject({ scale: 1, tier: 'gemini-standard' });
    expect(repriceSource(sp, active, { tier: 'gemini-lastresort', groupRatio: 1 / 8, at: nowSeconds }))
      .toMatchObject({ scale: 2, tier: 'gemini-lastresort', label: 'Gemini Last Resort' });
    // A fallback billed at the primary's price leaves the primary in place.
    expect(repriceSource(sp, active, { tier: 'gemini-reserve', groupRatio: 1 / 16, at: nowSeconds }))
      .toMatchObject({ scale: 1, tier: 'gemini-standard' });
    // Another family's source vouches for nothing here.
    expect(repriceSource(sp, active, { tier: 'kimi-lastresort', groupRatio: 1 / 5, at: nowSeconds }).scale).toBe(1);
  });

  it('never goes below the listed price', () => {
    const sp = importedPolicy(catalogModel('claude-opus-5-5', 3, .036)).sourcePricing!;
    const active = activeSources(profile(), '/v1/chat/completions').get('claude')!;
    const scale = repriceSource(sp, active, { tier: 'max', groupRatio: 5 / 28, at: nowSeconds }).scale;
    expect(scale).toBeCloseTo((25 / 112) / .036, 10);
  });

  it('matches the cost Relay billed for a real request', () => {
    // 2026-09-27 01:17:03 in the Relay usage log: $0.001986 on GPT Pro/Enterprise.
    const policy = importedPolicy({ ...catalogModel('gpt-6-sol', 1, .02), data: [{ ...catalogModel('gpt-6-sol', 1, .02).data[0], billing_mode: 'tiered_expr', billing_expr: 'len <= 272000 ? tier("short_context", p * 2 + c * 10 + cr * 0.2 + cc * 2.5) : tier("long_context", p * 4 + c * 15 + cr * 0.4 + cc * 5)' }] });
    const active = activeSources(profile({ gpt: 'gpt-pro-enterprise' }), '/v1/chat/completions').get('gpt')!;
    const next = repricedPolicy(policy, repriceSource(policy.sourcePricing!, active, { tier: 'gpt-pro-enterprise', groupRatio: .062, at: nowSeconds }));
    expect(costUsd(policyRates(next), { inputTokens: 916, outputTokens: 1614, cachedTokens: 70272 })).toBeCloseTo(.001986, 6);
  });
});

describe('mergeObservations', () => {
  it('keeps the newest billed ratio per model and drops expired ones', () => {
    const merged = mergeObservations(
      { old: { tier: 'kiro', groupRatio: .036, at: nowSeconds - 8 * 86400 }, 'gpt-6-sol': { tier: 'gpt-standard', groupRatio: .02, at: nowSeconds - 60 } },
      [logItem('gpt-6-sol', 'gpt-plus-pro', .034, nowSeconds - 10), logItem('gpt-6-sol', 'gpt-pro-enterprise', .062, nowSeconds - 3600), { model_name: 'x', created_at: nowSeconds, other: 'not json' }],
      now,
    );
    expect(merged).toEqual({ 'gpt-6-sol': { tier: 'gpt-plus-pro', groupRatio: .034, at: nowSeconds - 10 } });
  });
});

describe('billing policy', () => {
  it('hides the upstream source from consumers', () => {
    const policy = importedPolicy(catalogModel('gpt-6-sol', 1, .02));
    expect(publicBillingPolicy(policy)).not.toHaveProperty('sourcePricing');
    expect(publicBillingPolicy(policy)).not.toHaveProperty('origin');
  });

  it('stores scaled rates without float noise', () => {
    const base = [{ name: 'standard', rates: { inputPerMTok: .04, outputPerMTok: .2, cachedPerMTok: .004 } }];
    expect(scaleTiers(base, 1.7)[0]!.rates).toEqual({ inputPerMTok: .068, outputPerMTok: .34, cachedPerMTok: .0068 });
  });

  it('gives image models no source pricing', () => {
    const image = relayChannels({ ...catalogModel('gpt-image-2', 1, .02), data: [{ ...catalogModel('gpt-image-2', 1, .02).data[0], quota_type: 1, model_price: .01, supported_endpoint_types: ['image-generation'] }] })[0]!;
    expect(image.billing_policy.sourcePricing).toBeUndefined();
  });
});
