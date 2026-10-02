import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockingRule, openAiModerationRule } from './openai-moderation';
import type { Logger } from '@/lib/log';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('blockingRule', () => {
  it('prefers the most specific category', () => {
    expect(blockingRule({ sexual: true, 'sexual/minors': true })).toBe('minors');
  });

  it('leaves plain violence and harassment to the classifier', () => {
    expect(blockingRule({ violence: true, harassment: true, illicit: true })).toBeNull();
    expect(blockingRule({ 'violence/graphic': true })).toBe('graphic_violence');
  });
});

describe('openAiModerationRule', () => {
  it('does nothing without a key', async () => {
    for (const name of ['MODERATION_API_KEY', 'OPENAI_AI_KEY', 'OPENAI_API_KEY']) vi.stubEnv(name, '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await openAiModerationRule('anything', [], log)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends one image per call and reports a blocking category', async () => {
    vi.stubEnv('OPENAI_AI_KEY', 'sk-test');
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ results: [{ categories: { sexual: bodies.length === 2 } }] });
    }));
    const image = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg' };
    expect(await openAiModerationRule('a portrait', [image, image], log)).toBe('adult_sexual');
    expect(bodies).toHaveLength(2);
    expect((bodies[0] as { input: unknown[] }).input.filter((part) => (part as { type: string }).type === 'image_url')).toHaveLength(1);
  });

  it('never blocks on an outage; the classifier that fails closed decides', async () => {
    vi.stubEnv('OPENAI_AI_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    expect(await openAiModerationRule('a cat', [], log)).toBeNull();
  });
});
