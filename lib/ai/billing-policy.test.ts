import { describe, expect, it } from 'vitest';

import { billingPolicySchema } from './billing-policy';

describe('billingPolicySchema', () => {
  it('accepts both Relay and Kie catalog origins and preserves cache-write rates', () => {
    const base = {
      version: 'catalog-2026-09-25',
      syncedAt: '2026-09-25T00:00:00.000Z',
      tiers: [{
        name: 'standard',
        rates: { inputPerMTok: 0.6, outputPerMTok: 3, cachedPerMTok: 0.06, cacheWritePerMTok: 0.75 },
      }],
    };

    expect(billingPolicySchema.parse({ ...base, origin: 'relay.fast' }).tiers[0]?.rates.cacheWritePerMTok)
      .toBe(0.75);
    expect(billingPolicySchema.parse({ ...base, origin: 'kie.ai' }).tiers[0]?.rates.cacheWritePerMTok)
      .toBe(0.75);
    expect(() => billingPolicySchema.parse({ ...base, origin: 'unknown' })).toThrow();
  });
});
