import { APICallError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';

import { asUpstreamError } from '@/lib/api/upstream';

/**
 * The shape that motivated this: a gateway answering HTTP 200 with an error
 * envelope in the body. The OpenAI-compatible client cannot parse it and
 * raises `Invalid JSON response`, which previously surfaced to callers as a
 * 500 — our fault, by the status code, when it was never our fault.
 */
function apiCallError(overrides: Partial<ConstructorParameters<typeof APICallError>[0]> = {}) {
  return new APICallError({
    message: 'Invalid JSON response',
    url: 'https://api.example/v1/chat/completions',
    requestBodyValues: {},
    ...overrides,
  });
}

describe('asUpstreamError', () => {
  it('maps an unparseable 200 to a 502 rather than a 500', () => {
    const mapped = asUpstreamError(apiCallError({ statusCode: 200 }));
    expect(mapped).not.toBeNull();
    expect(mapped?.status).toBe(502);
    expect(mapped?.code).toBe('generation_failed');
  });

  it('maps an upstream 5xx to channel_unavailable', () => {
    expect(asUpstreamError(apiCallError({ statusCode: 503 }))?.status).toBe(503);
    expect(asUpstreamError(apiCallError({ statusCode: 500 }))?.code).toBe('channel_unavailable');
  });

  /**
   * The provider rejecting OUR key must not be reported as the caller's key
   * being bad — they would rotate a perfectly good credential.
   */
  it('never reports an upstream auth failure as the caller being unauthorized', () => {
    for (const statusCode of [401, 403]) {
      const mapped = asUpstreamError(apiCallError({ statusCode }));
      expect(mapped?.code).toBe('channel_unavailable');
      expect(mapped?.code).not.toBe('unauthorized');
    }
  });

  it('passes a caller-fault status back as a 400, not a retryable 502', () => {
    const mapped = asUpstreamError(apiCallError({ statusCode: 422, message: 'bad aspect_ratio' }));
    expect(mapped?.status).toBe(400);
    expect(mapped?.code).toBe('invalid_request');
  });

  it('treats upstream rate limiting as our channel being unavailable', () => {
    expect(asUpstreamError(apiCallError({ statusCode: 429 }))?.code).toBe('channel_unavailable');
  });

  it('unwraps a retry error to its last cause', () => {
    const mapped = asUpstreamError(
      new RetryError({
        message: 'failed after 2 attempts',
        reason: 'maxRetriesExceeded',
        errors: [apiCallError({ statusCode: 500 }), apiCallError({ statusCode: 200 })],
      }),
    );
    expect(mapped?.status).toBe(502);
  });

  /** A genuine bug of ours must still be a 500, or this hides real defects. */
  it('returns null for anything that is not an upstream fault', () => {
    expect(asUpstreamError(new TypeError('x is not a function'))).toBeNull();
    expect(asUpstreamError(new Error('boom'))).toBeNull();
    expect(asUpstreamError(null)).toBeNull();
  });
});
