import { describe, expect, it } from 'vitest';

import type { Family } from '@/lib/ai/source-types';
import { arrange } from './model-picker';

const families: Record<string, Family> = {
  'claude-opus-4-8': 'claude',
  'claude-haiku-4-5': 'claude',
  'gemini-3-5-flash-openai': 'gemini',
  'gpt-5-mini': 'gpt',
};
const models = ['claude-haiku-4-5', 'claude-opus-4-8', 'gemini-3-5-flash-openai', 'gpt-5-mini', 'mystery-1'];

describe('arrange', () => {
  it('groups by family in routing order, with Auto first and unknown models last', () => {
    const { groups, flat } = arrange(models, families, '');
    expect(groups.map((group) => group.family)).toEqual(['gpt', 'claude', 'gemini', 'other']);
    expect(flat).toEqual(['auto', 'gpt-5-mini', 'claude-haiku-4-5', 'claude-opus-4-8', 'gemini-3-5-flash-openai', 'mystery-1']);
  });

  it('matches every term against the name and the family label', () => {
    expect(arrange(models, families, 'claude opus').flat).toEqual(['claude-opus-4-8']);
    expect(arrange(models, families, 'google').flat).toEqual(['gemini-3-5-flash-openai']);
    expect(arrange(models, families, 'ANTHROPIC haiku').flat).toEqual(['claude-haiku-4-5']);
    expect(arrange(models, families, 'nothing-like-this').flat).toEqual([]);
  });

  it('matches word starts, so a short term does not hit the middle of a family name', () => {
    expect(arrange(models, families, 'anthropic op').flat).toEqual(['claude-opus-4-8']);
    expect(arrange(models, families, 'gpt5').flat).toEqual(['gpt-5-mini']);
    expect(arrange(models, families, 'opus-4').flat).toEqual(['claude-opus-4-8']);
  });

  it('keeps Auto reachable by searching for it', () => {
    expect(arrange(models, families, 'auto').flat).toEqual(['auto']);
  });
});
