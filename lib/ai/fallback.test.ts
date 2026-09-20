import { APICallError } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { callWithFallback, isRetryableError, type ChannelRow } from './fallback';
import { MODELS } from './models';
import { costUsd, creditsForUsage } from './pricing';

/** List prices matching the deleted PRICING constant for MODELS.cheap. */
const CHEAP_RATES = { inputPerMTok: 0.8, outputPerMTok: 4, cachedPerMTok: 0.08 };
const STRONG_RATES = { inputPerMTok: 15, outputPerMTok: 75, cachedPerMTok: 1.5 };

function channel(id: string, overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id,
    provider: 'anthropic',
    baseUrl: null,
    modelId: MODELS.cheap,
    creditMultiplier: '1.00',
    status: 'active',
    fallbackTo: null,
    rates: CHEAP_RATES,
    ...overrides,
  };
}

function httpError(status: number): Error & { statusCode: number } {
  return Object.assign(new Error(`http ${status}`), { statusCode: status });
}

function resolverFor(rows: ChannelRow[]): (id: string) => Promise<ChannelRow | null> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return (id) => Promise.resolve(byId.get(id) ?? null);
}

describe('callWithFallback', () => {
  it('succeeds on the first channel without resolving the chain', async () => {
    const resolve = vi.fn(resolverFor([]));
    const attempt = vi.fn(() => Promise.resolve('ok'));

    const result = await callWithFallback(channel('a', { fallbackTo: 'b' }), resolve, attempt);

    expect(result.value).toBe('ok');
    expect(result.channelId).toBe('a');
    expect(result.attempts).toEqual([{ channelId: 'a' }]);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('falls through to the next channel on 429 and succeeds there', async () => {
    const b = channel('b');
    const attempt = vi.fn((c: ChannelRow) =>
      c.id === 'a' ? Promise.reject(httpError(429)) : Promise.resolve('second'),
    );

    const result = await callWithFallback(
      channel('a', { fallbackTo: 'b' }),
      resolverFor([b]),
      attempt,
    );

    expect(result.value).toBe('second');
    expect(result.channelId).toBe('b');
    expect(result.attempts).toEqual([
      { channelId: 'a', error: 'http 429' },
      { channelId: 'b' },
    ]);
  });

  it('rethrows a 400 immediately without a second attempt', async () => {
    const b = channel('b');
    const badRequest = httpError(400);
    const attempt = vi.fn(() => Promise.reject(badRequest));

    await expect(
      callWithFallback(channel('a', { fallbackTo: 'b' }), resolverFor([b]), attempt),
    ).rejects.toBe(badRequest);

    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('skips channels with status off without attempting them', async () => {
    const off = channel('b', { status: 'off', fallbackTo: 'c' });
    const c = channel('c');
    const attempted: string[] = [];
    const attempt = vi.fn((row: ChannelRow) => {
      attempted.push(row.id);
      return row.id === 'c' ? Promise.resolve('third') : Promise.reject(httpError(503));
    });

    const result = await callWithFallback(
      channel('a', { fallbackTo: 'b' }),
      resolverFor([off, c]),
      attempt,
    );

    expect(attempted).toEqual(['a', 'c']);
    expect(result.channelId).toBe('c');
    expect(result.attempts).toEqual([
      { channelId: 'a', error: 'http 503' },
      { channelId: 'b', error: 'channel status: off' },
      { channelId: 'c' },
    ]);
  });

  it('terminates on a cyclic chain (a -> b -> a) and throws the last error', async () => {
    const a = channel('a', { fallbackTo: 'b' });
    const b = channel('b', { fallbackTo: 'a' });
    const lastError = httpError(500);
    const attempt = vi.fn((c: ChannelRow) =>
      Promise.reject(c.id === 'b' ? lastError : httpError(429)),
    );

    await expect(callWithFallback(a, resolverFor([a, b]), attempt)).rejects.toBe(lastError);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('throws the last error when the chain is exhausted', async () => {
    const b = channel('b');
    const lastError = httpError(502);
    const attempt = vi.fn((c: ChannelRow) =>
      Promise.reject(c.id === 'a' ? httpError(429) : lastError),
    );

    await expect(
      callWithFallback(channel('a', { fallbackTo: 'b' }), resolverFor([b]), attempt),
    ).rejects.toBe(lastError);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('stops after five channels on a long chain', async () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index, all) =>
      channel(id, { fallbackTo: all[index + 1] ?? null }),
    );
    const first = rows[0];
    if (first === undefined) throw new Error('fixture missing');
    const attempt = vi.fn(() => Promise.reject(httpError(500)));

    await expect(callWithFallback(first, resolverFor(rows), attempt)).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it('throws when every channel in the chain is off', async () => {
    const b = channel('b', { status: 'off' });
    const attempt = vi.fn(() => Promise.resolve('never'));

    await expect(
      callWithFallback(
        channel('a', { status: 'off', fallbackTo: 'b' }),
        resolverFor([b]),
        attempt,
      ),
    ).rejects.toThrow(/no usable channel/);
    expect(attempt).not.toHaveBeenCalled();
  });
});

describe('isRetryableError', () => {
  it('retries 429 and 5xx, not other 4xx', () => {
    expect(isRetryableError(httpError(429))).toBe(true);
    expect(isRetryableError(httpError(500))).toBe(true);
    expect(isRetryableError(httpError(503))).toBe(true);
    expect(isRetryableError(httpError(400))).toBe(false);
    expect(isRetryableError(httpError(401))).toBe(false);
    expect(isRetryableError(httpError(404))).toBe(false);
  });

  it('does not retry 408/409 even though the AI SDK marks them retryable', () => {
    const timeout = new APICallError({
      message: 'request timeout',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      statusCode: 408,
    });

    expect(timeout.isRetryable).toBe(true);
    expect(isRetryableError(timeout)).toBe(false);
  });

  it('honors isRetryable when there is no HTTP status', () => {
    const transport = new APICallError({
      message: 'fetch failed',
      url: 'https://api.anthropic.com/v1/messages',
      requestBodyValues: {},
      isRetryable: true,
    });

    expect(isRetryableError(transport)).toBe(true);
    expect(
      isRetryableError(
        new APICallError({
          message: 'bad payload',
          url: 'https://api.anthropic.com/v1/messages',
          requestBodyValues: {},
          isRetryable: false,
        }),
      ),
    ).toBe(false);
  });

  it('treats abort/timeout/network failures as retryable', () => {
    expect(isRetryableError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(
      true,
    );
    expect(isRetryableError(Object.assign(new Error('socket'), { code: 'ECONNRESET' }))).toBe(true);
    expect(
      isRetryableError(
        new Error('fetch failed', {
          cause: Object.assign(new Error('connect'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
        }),
      ),
    ).toBe(true);
  });

  it('is false for plain errors and non-objects', () => {
    expect(isRetryableError(new Error('boom'))).toBe(false);
    expect(isRetryableError('429')).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe('pricing', () => {
  it('prices cached input below fresh input', () => {
    expect(
      costUsd(STRONG_RATES, { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 }),
    ).toBeCloseTo(15, 10);
    expect(
      costUsd(STRONG_RATES, { inputTokens: 0, outputTokens: 1_000_000, cachedTokens: 0 }),
    ).toBeCloseTo(75, 10);
    expect(
      costUsd(STRONG_RATES, { inputTokens: 0, outputTokens: 0, cachedTokens: 1_000_000 }),
    ).toBeCloseTo(1.5, 10);
    expect(
      costUsd(CHEAP_RATES, { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0 }),
    ).toBeCloseTo(4.8, 10);
  });

  it('rejects a negative or non-finite rate rather than undercharging', () => {
    expect(() =>
      costUsd(
        { inputPerMTok: -1, outputPerMTok: 1, cachedPerMTok: 0 },
        { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      ),
    ).toThrow(/invalid inputPerMTok/);
    expect(() =>
      costUsd(
        { inputPerMTok: Number.NaN, outputPerMTok: 1, cachedPerMTok: 0 },
        { inputTokens: 1, outputTokens: 1, cachedTokens: 0 },
      ),
    ).toThrow(/invalid inputPerMTok/);
  });

  it('rounds credits up and honors the multiplier', () => {
    expect(creditsForUsage(0.0001, 1)).toBe(1);
    expect(creditsForUsage(0.00015, 1)).toBe(2);
    expect(creditsForUsage(0.00001, 1)).toBe(1);
    expect(creditsForUsage(0.001, 1)).toBe(10);
    expect(creditsForUsage(0.001, 1.5)).toBe(15);
    expect(creditsForUsage(0.0001, 2.5)).toBe(3);
  });

  it('charges nothing for a zero multiplier (BYOK) or zero cost', () => {
    expect(creditsForUsage(12.34, 0)).toBe(0);
    expect(creditsForUsage(0, 3)).toBe(0);
  });

  it('rejects negative inputs', () => {
    expect(() => creditsForUsage(-1, 1)).toThrow(/invalid costUsd/);
    expect(() => creditsForUsage(1, -1)).toThrow(/invalid multiplier/);
    expect(() =>
      costUsd(CHEAP_RATES, { inputTokens: -1, outputTokens: 0, cachedTokens: 0 }),
    ).toThrow(/invalid inputTokens/);
  });
});
