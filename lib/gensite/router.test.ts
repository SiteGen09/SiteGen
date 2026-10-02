import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatMessage, ChatTool } from '@/lib/chat/request';
import { gensiteListed, isExcluded, routeExclusions, tierModels } from './config';
import {
  assessDifficulty,
  chooseTier,
  decideRoute,
  extractFeatures,
  LONG_CONTEXT_CHARS,
  type RouteFeatures,
} from './router';

const BASE: RouteFeatures = {
  inputChars: 2_000,
  hasTools: false,
  hasImages: false,
  reasoning: undefined,
  lastUserChars: 1_000,
  codeSignals: false,
  difficulty: null,
};

const TOOL: ChatTool = { type: 'function', function: { name: 'bash', parameters: { type: 'object' } } } as ChatTool;

describe('chooseTier', () => {
  it('sends agent turns to the coders', () => {
    expect(chooseTier({ ...BASE, hasTools: true })).toBe('coder');
  });

  it('sends a huge prompt to the long tier before anything else', () => {
    expect(chooseTier({ ...BASE, hasTools: true, reasoning: 'xhigh', inputChars: LONG_CONTEXT_CHARS + 1 })).toBe('long');
  });

  it('honours the reasoning effort in both directions', () => {
    expect(chooseTier({ ...BASE, reasoning: 'xhigh' })).toBe('max');
    expect(chooseTier({ ...BASE, reasoning: 'high' })).toBe('coder');
    expect(chooseTier({ ...BASE, reasoning: 'low' })).toBe('fast');
  });

  it('sends pictures without tools to vision, and with tools to the coders', () => {
    expect(chooseTier({ ...BASE, hasImages: true })).toBe('vision');
    expect(chooseTier({ ...BASE, hasImages: true, hasTools: true })).toBe('coder');
  });

  it('follows the difficulty, and asks the classifier only when the rules cannot tell', () => {
    expect(decideRoute({ ...BASE, difficulty: 'simple' })).toEqual({ tier: 'fast', classify: false });
    expect(decideRoute({ ...BASE, difficulty: 'hard' })).toEqual({ tier: 'max', classify: false });
    expect(decideRoute(BASE)).toEqual({ tier: 'balanced', classify: true });
  });

  it('sends code to the coders, and hard code or hard pictures to the strongest', () => {
    expect(chooseTier({ ...BASE, codeSignals: true })).toBe('coder');
    expect(chooseTier({ ...BASE, codeSignals: true, difficulty: 'hard' })).toBe('max');
    expect(chooseTier({ ...BASE, hasImages: true, difficulty: 'hard' })).toBe('max');
  });

  it('never classifies an agent turn', () => {
    expect(decideRoute({ ...BASE, hasTools: true })).toEqual({ tier: 'coder', classify: false });
  });
});

describe('extractFeatures', () => {
  it('reads the newest user message and spots code and images', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'Why does this throw?\n```ts\nconst x = y.z;\n```', attachments: [{ data: 'x', mediaType: 'image/png' }] },
    ];
    const features = extractFeatures({ messages, tools: [TOOL], reasoning: 'medium' });
    expect(features).toMatchObject({ hasTools: true, hasImages: true, codeSignals: true, reasoning: 'medium' });
    expect(features.lastUserChars).toBe(messages[2]!.content!.length);
  });

  it('does not mistake small talk for code', () => {
    expect(extractFeatures({ messages: [{ role: 'user', content: 'What is the capital of France?' }] }).codeSignals).toBe(false);
  });
});

describe('gensite config', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps Provider A Claude models out by default but not its other models', () => {
    const rules = routeExclusions();
    expect(isExcluded(rules, 'relay.fast', 'claude-opus-5-5')).toBe(true);
    expect(isExcluded(rules, 'relay.fast', 'gpt-6-astra')).toBe(false);
    expect(isExcluded(rules, 'kie.ai', 'claude-opus-5-5')).toBe(false);
  });

  it('lets the environment replace the exclusions and the tier lists', () => {
    vi.stubEnv('GENSITE_EXCLUDED_PROVIDERS', 'none');
    expect(routeExclusions()).toEqual([]);
    vi.stubEnv('GENSITE_EXCLUDED_PROVIDERS', 'kie.ai, relay.fast:gpt');
    const rules = routeExclusions();
    expect(isExcluded(rules, 'kie.ai', 'anything')).toBe(true);
    expect(isExcluded(rules, 'relay.fast', 'gpt-6-sol')).toBe(true);
    expect(isExcluded(rules, 'relay.fast', 'claude-opus-5-5')).toBe(false);

    vi.stubEnv('GENSITE_TIER_FAST', 'model-a, gensite-v1 ,model-b');
    expect(tierModels('fast')).toEqual(['model-a', 'model-b']);
  });

  it('names no Claude model in the default tiers', () => {
    for (const tier of ['fast', 'balanced', 'coder', 'max', 'vision', 'long'] as const) {
      expect(tierModels(tier).some((model) => model.startsWith('claude-'))).toBe(false);
    }
  });

  it('is listed only when a model it routes to is reachable', () => {
    expect(gensiteListed(['gpt-6-sol'])).toBe(true);
    expect(gensiteListed(['some-other-model'])).toBe(false);
  });
});

/**
 * A labelled sample of real-world prompts. `null` means the rules should
 * defer to the classifier rather than guess.
 */
const SAMPLES: Array<[string, 'simple' | 'hard' | null]> = [
  ['hi', 'simple'],
  ['thanks!', 'simple'],
  ['what AI model are you?', 'simple'],
  ['What is the capital of Australia?', 'simple'],
  ['Translate "good morning, how are you" into Japanese.', 'simple'],
  ['Fix the grammar in this sentence: me and him goes to the store yesterday to buyed some milk.', 'simple'],
  ['Prove that there are infinitely many primes of the form 4k+3.', 'hard'],
  ['Design a multi-region failover strategy for a payments database.', 'hard'],
  ['Analyze the trade-offs between event sourcing and CRUD for an order management system.', 'hard'],
  ['Compute the integral of x^2 * e^x from 0 to 1, step by step.', 'hard'],
  ['What is the root cause of the 2008 financial crisis, and what could regulators have done differently?', 'hard'],
  ['Write a comprehensive go-to-market strategy and financial model for a B2B SaaS startup.', 'hard'],
  ['Can you recommend a good book about the history of Rome for a beginner?', null],
  ['Write a friendly email to my landlord asking to fix the heating this week.', null],
  ['Why do cats purr, and is it always a sign that they are happy or relaxed?', null],
];

describe('assessDifficulty on sample prompts', () => {
  it.each(SAMPLES)('%s → %s', (prompt, expected) => {
    expect(assessDifficulty(prompt)).toBe(expected);
  });

  it('reads the dashboard\'s part-array messages, text and images alike', () => {
    const features = extractFeatures({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Prove that the square root of 2 is irrational.' },
          { type: 'file', data: 'data:image/png;base64,AA', mediaType: 'image/png' },
        ] as unknown as string,
      }],
    });
    expect(features.difficulty).toBe('hard');
    expect(features.hasImages).toBe(true);
    expect(chooseTier(features)).toBe('max');
  });
});
