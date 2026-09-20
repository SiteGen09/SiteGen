import { describe, expect, it } from 'vitest';
import { discountPercent } from './public-prices';
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
