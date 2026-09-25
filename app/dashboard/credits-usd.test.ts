import { describe, expect, it } from 'vitest';

import { formatCreditsUsd } from './ui';

describe('formatCreditsUsd', () => {
  it.each([
    [0, '$0.00'],
    [1, '$0.0001'],
    [6, '$0.0006'],
    [1_058, '$0.1058'],
    [5_000, '$0.50'],
    [10_000, '$1.00'],
    [149_000, '$14.90'],
    [12_345_678, '$1,234.57'],
    [-34, '-$0.0034'],
  ])('%d credits reads as %s', (credits, expected) => {
    expect(formatCreditsUsd(credits)).toBe(expected);
  });
});
