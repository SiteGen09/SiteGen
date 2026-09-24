import { describe, expect, it } from 'vitest';
import { publicRoutingProviderIdentity, publicRoutingSourceId, publicRoutingSourceLabel, publicRoutingTags, routingProviderIdentity } from '@/lib/ai/routing-provider';
import { publicBillingPolicy } from '@/lib/ai/billing-policy';
import { groupRoutingProviders } from './routing-catalog';
import { routingPriceChanges, type RoutingAudit } from './routing-history';
import type { ModelCatalogEntry } from './queries';

function model(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: 'relay-gpt-5', sourceId: 'relay-gpt-chat', sourceLabel: 'Relay.fast',
    sourceDescription: 'Configured provider description.', family: 'gpt', modality: 'chat',
    publicModelId: 'gpt-5', label: 'GPT 5', provider: 'openai_compatible',
    upstreamModelId: 'private-upstream-model', status: 'active', minPlan: 'free', isByok: false,
    creditMultiplier: 1.5, inputCreditsPerMTok: 15000, outputCreditsPerMTok: 30000,
    cachedCreditsPerMTok: 1500, requestCredits: null,
    ...overrides,
  };
}

describe('provider catalog', () => {
  it('groups model families and protocols into one card per upstream provider', () => {
    const catalog = [
      model(),
      model({ id: 'relay-claude', sourceId: 'relay-claude-chat', family: 'claude' }),
      model({ id: 'relay-image', sourceId: 'relay-gpt-image', modality: 'image', provider: 'openai_images', requestCredits: 300 }),
      model({ id: 'kie-gpt', sourceId: 'kie-gpt-chat', sourceLabel: 'kie.ai gpt chat', sourceDescription: 'kie.ai chat models from gpt', inputCreditsPerMTok: 9000 }),
      model({ id: 'kie-video', sourceId: 'kie-kling-video', sourceLabel: 'kie.ai kling video', sourceDescription: 'kie.ai video models from kling', modality: 'video', provider: 'kie_jobs' }),
    ];
    const providers = groupRoutingProviders(catalog);
    expect(providers.map((provider) => [provider.label, provider.models.length])).toEqual([['Provider A', 3], ['Provider B', 2]]);
    expect(providers[1]?.models.find((row) => row.id === 'kie-gpt')?.inputCreditsPerMTok).toBe(9000);
    expect(providers[0]?.models.find((row) => row.id === 'relay-gpt-5')?.inputCreditsPerMTok).toBe(15000);
    expect(providers[0]?.description).toBe('Configured provider description.');
    expect(providers[1]?.description).toContain('Chat, Video');
    expect(JSON.stringify(providers)).not.toContain('private-upstream-model');
    expect(JSON.stringify(providers)).not.toContain('upstreamModelId');
  });

  it('uses the actual endpoint identity without returning URL secrets', () => {
    expect(routingProviderIdentity({ baseUrl: 'https://secret:password@api.kie.ai/v1?token=private', sourceLabel: 'OpenAI' })).toEqual({ id: 'kie.ai', label: 'kie.ai' });
    expect(routingProviderIdentity({ baseUrl: 'https://relay.fast/v1', provider: 'openai_images' })).toEqual({ id: 'relay.fast', label: 'relay.fast' });
    expect(routingProviderIdentity({ baseUrl: 'https://other.example/v1', provider: 'openai_compatible' })).toEqual({ id: 'other.example', label: 'other.example' });
    expect(publicRoutingProviderIdentity({ baseUrl: 'https://relay.fast/v1' })).toEqual({ id: 'provider-a', label: 'Provider A' });
    expect(publicRoutingProviderIdentity({ baseUrl: 'https://api.kie.ai/v1' })).toEqual({ id: 'provider-b', label: 'Provider B' });
    expect(publicRoutingSourceId('relay-gpt-chat')).toMatch(/^source-a-/);
    expect(publicRoutingSourceId('kie-gpt-chat')).toMatch(/^source-b-/);
  });

  it('projects anonymous provider metadata for consumers', () => {
    expect(publicRoutingSourceLabel('Relay.fast published pricing')).toBe('Provider A');
    expect(publicRoutingSourceLabel('kie.ai gpt chat')).toBe('Provider B');
    expect(publicRoutingTags(['relay.fast', 'tiered'])).toEqual(['tiered']);
    const policy = publicBillingPolicy({ origin: 'relay.fast', version: 'v', syncedAt: '2026-09-21', tiers: [{ name: 'standard', rates: { inputPerMTok: 1, outputPerMTok: 2, cachedPerMTok: 0.1 } }] });
    expect(policy).not.toHaveProperty('origin');
    expect(policy).toMatchObject({ version: 'v' });
  });

  it('excludes BYOK and disabled channels without merging different compatible providers', () => {
    const providers = groupRoutingProviders([
      model({ isByok: true }), model({ status: 'off' }),
      model({ id: 'a', routingProvider: { id: 'one.example', label: 'one.example' } }),
      model({ id: 'b', routingProvider: { id: 'two.example', label: 'two.example' } }),
    ]);
    expect(providers.map((provider) => provider.id)).toEqual(['one.example', 'two.example']);
    expect(providers.every((provider) => provider.models.length === 1)).toBe(true);
  });
});

describe('routing price history', () => {
  const audit: RoutingAudit = { id: 12, action: 'channel.update', target: 'channel:relay-gpt-5', created_at: '2026-09-21T00:00:00Z', before: null, after: null };

  it('projects individual changed rates without leaking the source snapshot', () => {
    const before = { pricing_type: 'token', input_per_mtok: '1.25', output_per_mtok: '10', cached_per_mtok: '0.1', base_url: 'https://secret.example', model_id: 'private-model' };
    const history = routingPriceChanges({ ...audit, before, after: { ...before, input_per_mtok: '2.5' } }, [model()]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ providerLabel: 'Provider A', modelLabel: 'GPT 5', priceLabel: 'Input', unit: 'usd_per_mtok', previous: 1.25, current: 2.5 });
    expect(JSON.stringify(history)).not.toMatch(/secret|private-model|base_url/);
  });

  it('ignores metadata edits and invalid multiplier snapshots', () => {
    expect(routingPriceChanges({ ...audit, before: { input_per_mtok: '1' }, after: { input_per_mtok: 1, label: 'Renamed' } }, [model()])).toEqual([]);
    for (const previous of [null, '', 'invalid', undefined]) {
      expect(routingPriceChanges({ ...audit, action: 'source.update', target: 'source:relay-gpt-chat', before: { credit_multiplier: previous }, after: { credit_multiplier: 2 } }, [model()])).toEqual([]);
    }
  });

  it('records multipliers and per-job prices with distinct units', () => {
    expect(routingPriceChanges({ ...audit, action: 'source.update', target: 'source:relay-gpt-chat', before: { credit_multiplier: '1.5' }, after: { credit_multiplier: '2' } }, [model()])[0]).toMatchObject({ unit: 'multiplier', previous: 1.5, current: 2, modelLabel: null });
    expect(routingPriceChanges({ ...audit, before: { pricing_type: 'request', request_price_usd: '.02' }, after: { pricing_type: 'request', request_price_usd: '.04' } }, [model({ modality: 'image' })])[0]).toMatchObject({ unit: 'usd_per_job', previous: .02, current: .04 });
  });

  it('does not show prices for internal or inaccessible model IDs', () => {
    expect(routingPriceChanges({ ...audit, target: 'channel:private', before: { input_per_mtok: 1 }, after: { input_per_mtok: 2 } }, [model()])).toEqual([]);
  });

  it('compares policy tiers and ignores a pricing sync with unchanged prices', () => {
    const policy = { origin: 'relay.fast', version: '1', syncedAt: '2026-09-20', tiers: [{ name: 'standard', rates: { inputPerMTok: 1, outputPerMTok: 2, cachedPerMTok: .1 } }, { name: 'long_context', rates: { inputPerMTok: 3, outputPerMTok: 6, cachedPerMTok: .3 } }], contextThreshold: 200000 };
    const before = { pricing_type: 'token', billing_policy: policy };
    expect(routingPriceChanges({ ...audit, before, after: { ...before, billing_policy: { ...policy, syncedAt: '2026-09-21', version: '2' } } }, [model()])).toEqual([]);
    const after = { ...before, billing_policy: { ...policy, tiers: [policy.tiers[0], { ...policy.tiers[1], rates: { ...policy.tiers[1]!.rates, outputPerMTok: 8 } }] } };
    expect(routingPriceChanges({ ...audit, before, after }, [model()])).toEqual([expect.objectContaining({ priceLabel: 'long context · Output', previous: 6, current: 8 })]);
  });
});
