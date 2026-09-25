import { describe, expect, it } from 'vitest';
import { comparePublicPrices, discountPercent, matchesPublicPriceSearch, requestPriceKind, type PublicPrice } from './public-prices';
import { priceMetadataFields } from '@/lib/ai/price-metadata';

describe('public price metadata', () => {
  it('computes discounts only for a verified higher list price', () => {
    expect(discountPercent(2, 100)).toBe(98);
    expect(discountPercent(2, null)).toBeNull();
    expect(discountPercent(2, 0)).toBeNull();
    expect(discountPercent(2, 1)).toBeNull();
  });
  it('keeps absent list prices null and rejects negative prices', () => {
    expect(priceMetadataFields.listInputPerMTok.parse('')).toBeNull();
    expect(priceMetadataFields.listInputPerMTok.parse('0.25')).toBe(0.25);
    expect(priceMetadataFields.listInputPerMTok.safeParse('-1').success).toBe(false);
  });
});


function price(overrides: Partial<PublicPrice> = {}): PublicPrice {
  return {
    model: 'model', label: 'Model', group: 'gpt', vendor: 'openai', contextWindow: null,
    endpoints: [], tags: [], pricingType: 'token', status: 'active', modality: 'chat', providerId: 'relay.fast',
    sourceLabel: 'relay.fast', multiplier: 1.5, input: 100, output: 200, cached: 10,
    request: null, requestPriceKind: null, listInput: null, listOutput: null, listCached: null,
    listRequest: null, ...overrides,
  };
}

describe('provider request prices', () => {
  it('keeps media prices in the per-job unit and never treats them as token zeros', () => {
    expect(requestPriceKind('kie_jobs')).toBe('up_to');
    expect(requestPriceKind('openai_images', { origin: 'relay.fast', version: 'v', syncedAt: '2026-09-21', tiers: [{ name: 'standard', rates: { inputPerMTok: 0, outputPerMTok: 0, cachedPerMTok: 0 } }], imagePrices: { standard: .01, large: .02 } })).toBe('from');
    const media = price({ pricingType: 'request', modality: 'image', providerId: 'kie.ai', sourceLabel: 'kie.ai', input: null, output: null, cached: null, request: 450, requestPriceKind: 'up_to' });
    expect(media.request).toBe(450);
    expect(media.input).toBeNull();
    expect(comparePublicPrices(price(), media, 'request', true)).toBeGreaterThan(0);
  });

  it('keeps unpublished reference prices absent', () => {
    const kie = price({ providerId: 'kie.ai', sourceLabel: 'kie.ai', listInput: null, listOutput: null, listCached: null });
    expect(kie.listInput).toBeNull();
    expect(kie.listOutput).toBeNull();
    expect(kie.listCached).toBeNull();
  });
});

describe('public price search', () => {
  it('matches all terms across model metadata, serving status, and pricing', () => {
    const row = price({ model: 'flux-pro', label: 'FLUX Pro', vendor: 'Black Forest Labs',
      sourceLabel: 'Relay Images', modality: 'image', pricingType: 'request', status: 'degraded',
      tags: ['fast', 'text-to-image'], endpoints: ['images'], contextWindow: 4096 });
    expect(matchesPublicPriceSearch(row, 'relay image degraded')).toBe(true);
    expect(matchesPublicPriceSearch(row, 'text-to-image images')).toBe(true);
    expect(matchesPublicPriceSearch(row, 'flux operational')).toBe(false);
  });
});
