import { describe, expect, it } from 'vitest';
import { isProviderReprice, uniformMultiplier } from './provider-pricing';

const uniform = { managedMultiplier: null, minMultiplier: '1.50', maxMultiplier: '1.50' };
const mixed = { managedMultiplier: null, minMultiplier: '1.20', maxMultiplier: '1.50' };
const managed = { managedMultiplier: '1.30', minMultiplier: '1.30', maxMultiplier: '1.30' };

describe('provider repricing', () => {
  it('reads a shared multiplier and treats mixed prices as none', () => {
    expect(uniformMultiplier(uniform)).toBe(1.5);
    expect(uniformMultiplier(mixed)).toBeNull();
    expect(uniformMultiplier({ minMultiplier: null, maxMultiplier: null })).toBeNull();
  });

  it('needs no reprice to rename or to re-enter the current price', () => {
    expect(isProviderReprice(uniform, null)).toBe(false);
    expect(isProviderReprice(uniform, 1.5)).toBe(false);
    expect(isProviderReprice(managed, 1.3)).toBe(false);
  });

  it('reprices a new price, and any price for a mixed provider', () => {
    expect(isProviderReprice(uniform, 1.3)).toBe(true);
    expect(isProviderReprice(managed, 1.5)).toBe(true);
    expect(isProviderReprice(mixed, 1.5)).toBe(true);
  });
});
