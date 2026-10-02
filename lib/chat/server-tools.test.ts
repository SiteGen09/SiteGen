import { describe, expect, it, vi } from 'vitest';

import {
  createWebSearchKit,
  forcesServerTool,
  segmentsText,
  serverToolName,
  turnSegments,
  type WebSearchOutput,
} from './server-tools';

type Execute = (input: { query: string }, options: { abortSignal?: AbortSignal; toolCallId: string; messages: [] }) => Promise<WebSearchOutput>;

function kitWith(search = vi.fn(async () => [{ title: 'T', url: 'https://example.com', content: 'body' }]), maxSearches = 2) {
  const kit = createWebSearchKit({ search, name: 'web_search', maxSearches, usdPerSearch: 0.008, now: new Date('2026-09-28T00:00:00Z') });
  const execute = (kit.tools.web_search as unknown as { execute: Execute }).execute;
  const run = (query: string) => execute({ query }, { toolCallId: 'c', messages: [] });
  return { kit, run, search };
}

describe('createWebSearchKit', () => {
  it('runs searches, counts and prices only the ones that returned', async () => {
    const failing = vi.fn()
      .mockResolvedValueOnce([{ title: 'T', url: 'https://a.test', content: 'x', publishedDate: '2026-09-01' }])
      .mockRejectedValueOnce(new Error('down'));
    const { kit, run } = kitWith(failing);
    expect(await run('first')).toEqual({ results: [{ title: 'T', url: 'https://a.test', content: 'x', published: '2026-09-01' }] });
    expect(await run('second')).toHaveProperty('error');
    expect(kit.searchCount()).toBe(1);
    expect(kit.costUsd()).toBeCloseTo(0.008);
    expect(kit.reserveUsd).toBeCloseTo(0.016);
  });

  it('stops at the search budget without calling the backend again', async () => {
    const { run, search } = kitWith(undefined, 1);
    await run('one');
    expect(await run('two')).toEqual({ error: expect.stringContaining('limit') });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('refuses every search once disabled', async () => {
    const { kit, run, search } = kitWith();
    kit.disable('not on your own key');
    expect(await run('q')).toEqual({ error: 'not on your own key' });
    expect(search).not.toHaveBeenCalled();
  });

  it('withdraws its tools on the last step and after the budget is spent', async () => {
    const { kit, run } = kitWith(undefined, 1);
    const step = kit.prepareStep(['bash'], false);
    expect(step({ stepNumber: 0 })).toBeUndefined();
    expect(step({ stepNumber: kit.maxSteps - 1 })).toEqual({ activeTools: ['bash'] });
    await run('q');
    expect(step({ stepNumber: 1 })).toEqual({ activeTools: ['bash'] });
  });

  it('applies a forced choice of the search tool to the first step only', () => {
    const { kit } = kitWith(undefined, 3);
    const step = kit.prepareStep([], true);
    expect(step({ stepNumber: 0 })).toBeUndefined();
    expect(step({ stepNumber: 1 })).toEqual({ toolChoice: 'auto' });
  });
});

describe('turn helpers', () => {
  it('orders text and gateway runs by step and ignores the caller\'s tools', () => {
    const segments = turnSegments([
      { text: 'Let me check.', toolResults: [{ toolCallId: 's1', toolName: 'web_search', input: { query: 'q' }, output: { results: [] } }] },
      { text: 'Here it is.', toolResults: [{ toolCallId: 'c1', toolName: 'bash', input: {}, output: 'x' }] },
    ], new Set(['web_search']));
    expect(segments.map((segment) => segment.type)).toEqual(['text', 'server-tool', 'text']);
    expect(segmentsText(segments)).toBe('Let me check.\n\nHere it is.');
  });

  it('names the tool so it never shadows the caller\'s', () => {
    expect(serverToolName(['bash'])).toBe('web_search');
    expect(serverToolName(['web_search'])).toBe('gensite_web_search');
    expect(serverToolName(['web_search', 'gensite_web_search'])).toBe('gensite_web_search_2');
  });

  it('recognises a forced choice of a gateway tool', () => {
    const names = new Set(['web_search']);
    expect(forcesServerTool({ type: 'function', function: { name: 'web_search' } }, names)).toBe(true);
    expect(forcesServerTool('required', names)).toBe(false);
  });
});

describe('repeated searches', () => {
  it('answers a repeat from the first search, free, and withdraws the tool after two repeats', async () => {
    const { kit, run, search } = kitWith(undefined, 5);
    await run('Next.js 17 release date');
    const repeat = await run('  next.js 17 RELEASE date? ');
    expect(repeat).toMatchObject({ results: [{ url: 'https://example.com' }], note: expect.stringContaining('already ran') });
    expect(search).toHaveBeenCalledTimes(1);
    expect(kit.searchCount()).toBe(1);
    const step = kit.prepareStep([], false);
    expect(step({ stepNumber: 1 })).toBeUndefined();
    await run('next.js 17 release date');
    expect(step({ stepNumber: 1 })).toEqual({ activeTools: [] });
  });
});

