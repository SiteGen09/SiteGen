import { describe, expect, it } from 'vitest';

import { formatDuration } from './duration';

describe('formatDuration', () => {
  it.each([
    [0, '0 ms'],
    [850, '850 ms'],
    [999.6, '1.0 s'],
    [1000, '1.0 s'],
    [14_217, '14.2 s'],
    [41_051, '41.1 s'],
    [59_940, '59.9 s'],
    [59_960, '1 m'],
    [60_000, '1 m'],
    [88_910, '1 m 29 s'],
    [226_825, '3 m 47 s'],
    [3_599_600, '1 h'],
    [3_900_000, '1 h 5 m'],
  ])('%d ms reads as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('shows a dash for nonsense', () => {
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(-5)).toBe('—');
  });
});
