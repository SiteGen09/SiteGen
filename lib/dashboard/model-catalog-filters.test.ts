import { describe, expect, it } from 'vitest';
import type { ModelCatalogEntry } from './queries';
import type { ModelStatusRow } from './model-status';
import { filterModelCatalog, filterModelStatusRows } from './model-catalog-filters';

function model(overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry {
  return {
    id: 'gpt-route', routingProvider: { id: 'relay.fast', label: 'Relay Fast' },
    sourceId: 'openai', sourceLabel: 'OpenAI', sourceDescription: 'Fast chat models', family: 'gpt',
    modality: 'chat', publicModelId: 'gpt-4.1', label: 'GPT 4.1', provider: 'openai_compatible',
    upstreamModelId: 'gpt-4.1', status: 'active', minPlan: 'pro', isByok: false, creditMultiplier: 1,
    inputCreditsPerMTok: 200, outputCreditsPerMTok: 800, cachedCreditsPerMTok: 20,
    requestCredits: null, pricingType: 'token', ...overrides,
  };
}

function statusRow(overrides: Partial<ModelStatusRow> = {}): ModelStatusRow {
  return {
    publicModelId: 'gpt-4.1', label: 'GPT 4.1', health: 'operational', requests: 20, failed: 0,
    rejected: 0, errorRate: 0, p95LatencyMs: 300, lastSuccessAt: null, lastFailureAt: null, ...overrides,
  };
}

describe('model catalog filters', () => {
  const models = [
    model(),
    model({ id: 'flux-route', publicModelId: 'flux-pro', label: 'FLUX Pro', family: 'flux',
      modality: 'image', pricingType: 'request', requestCredits: 35, minPlan: 'starter',
      sourceLabel: 'Relay Images', inputCreditsPerMTok: 0 }),
    model({ id: 'byok-route', publicModelId: 'claude-sonnet', label: 'Claude Sonnet', family: 'claude',
      isByok: true, sourceLabel: 'BYOK', status: 'degraded', inputCreditsPerMTok: 0 }),
  ];

  it('searches all words across model, family, provider, and source details', () => {
    expect(filterModelCatalog(models, { query: 'fast gpt-4.1' }).map((row) => row.id)).toEqual(['gpt-route']);
    expect(filterModelCatalog(models, { query: 'anthropic claude' }).map((row) => row.id)).toEqual(['byok-route']);
    expect(filterModelCatalog(models, { query: 'claude byok' }).map((row) => row.id)).toEqual(['byok-route']);
  });

  it('combines status, modality, pricing, access, plan, and credit ceilings', () => {
    expect(filterModelCatalog(models, { status: 'degraded', access: 'byok' }).map((row) => row.id))
      .toEqual(['byok-route']);
    expect(filterModelCatalog(models, { family: 'flux', modality: 'image', pricing: 'request', plan: 'starter', maxRequest: 40 })
      .map((row) => row.id)).toEqual(['flux-route']);
    expect(filterModelCatalog(models, { pricing: 'token', maxInput: 250, access: 'credits' })
      .map((row) => row.id)).toEqual(['gpt-route']);
    expect(filterModelCatalog(models, { planAccess: 'included', availablePlanRank: 1 })
      .map((row) => row.id)).toEqual(['flux-route']);
  });
});

describe('model status filters', () => {
  it('searches model identifiers and labels while applying health filters', () => {
    const rows = [statusRow(), statusRow({ publicModelId: 'flux-pro', label: 'FLUX Pro', health: 'degraded' })];
    expect(filterModelStatusRows(rows, { query: 'flux', health: 'degraded' }).map((row) => row.publicModelId))
      .toEqual(['flux-pro']);
    expect(filterModelStatusRows(rows, { query: 'missing' })).toEqual([]);
    expect(filterModelStatusRows([statusRow({ health: 'idle' })], { query: 'no recent traffic' })).toHaveLength(1);
  });
});
