import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateRelayImage, prepareRelayImage } from './relay';
import type { MediaChannelRow } from '@/lib/ai/channels';

const channel: MediaChannelRow = { id: 'relay-gpt-image-2', provider: 'openai_images', modelId: 'gpt-image-2', baseUrl: 'https://relay.fast/v1', creditMultiplier: '1.5', requestPriceUsd: .01, billingPolicy: { origin: 'relay.fast', version: 'v', syncedAt: '2026-09-21', tiers: [{ name: 'standard', rates: { inputPerMTok: 0, outputPerMTok: 0, cachedPerMTok: 0 } }], imagePrices: { standard: .01, large: .02 } } };
afterEach(() => vi.unstubAllGlobals());
describe('Relay images', () => {
  it('prices explicit dimensions at the 1792 pixel boundary', () => {
    expect(prepareRelayImage(channel, { prompt: 'test', size: '1792x1024' }).costUsd).toBe(.01);
    expect(prepareRelayImage(channel, { prompt: 'test', size: '1793x1024' }).costUsd).toBe(.02);
    expect(prepareRelayImage(channel, { prompt: 'test', size: '4K' }).costUsd).toBe(.02);
    expect(prepareRelayImage(channel, { prompt: 'test' }).costUsd).toBe(.01);
  });
  it('rejects unsupported options before spending any credits', () => {
    for (const input of [{ prompt: 'x', n: 2 }, { prompt: 'x', size: 'auto' }, { prompt: 'x', unknown: true }, { prompt: '' }]) expect(() => prepareRelayImage(channel, input)).toThrow();
  });
  it('uses the image endpoint and does not leak upstream error bodies', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'private upstream detail' }), { status: 429 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(generateRelayImage({ provider: 'openai_images', apiKey: 'test-key', baseUrl: 'https://relay.fast/v1' }, 'gpt-image-2', { prompt: 'test' })).rejects.toThrow('HTTP 429');
    expect(fetcher.mock.calls[0]![0]).toBe('https://relay.fast/v1/images/generations');
  });
});
