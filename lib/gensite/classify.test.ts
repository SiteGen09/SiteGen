import { describe, expect, it } from 'vitest';

import type { ChannelRow } from '@/lib/ai/fallback';
import { classifyDifficulty, parseDifficulty } from './classify';

describe('parseDifficulty', () => {
  it('finds the verdict whatever surrounds it', () => {
    expect(parseDifficulty('HARD')).toBe('hard');
    expect(parseDifficulty('  medium.\n')).toBe('medium');
    expect(parseDifficulty('The answer is: Simple')).toBe('simple');
  });

  it('returns null when there is no verdict', () => {
    expect(parseDifficulty('')).toBeNull();
    expect(parseDifficulty('hardly')).toBeNull();
  });
});

describe('classifyDifficulty', () => {
  it('never throws; a failure comes back as no verdict', async () => {
    const result = await classifyDifficulty({
      text: 'anything',
      channel: { id: 'c', modelId: 'm' } as ChannelRow,
      buildCreds: async () => { throw new Error('no credential'); },
    });
    expect(result.difficulty).toBeNull();
    expect(result.failure).toBe('Error');
  });
});
