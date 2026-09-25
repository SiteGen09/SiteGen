import { describe, expect, it } from 'vitest';
import { requestOriginMatches } from './request-origin';

describe('requestOriginMatches', () => {
  it('accepts the configured public origin when the request URL is an internal HTTP hop', () => {
    const request = new Request('http://127.0.0.1:3000/api/chat', {
      headers: { origin: 'https://gensite.tech' },
    });
    expect(requestOriginMatches(request, 'https://gensite.tech')).toBe(true);
  });

  it('keeps same-origin local requests working without a configured public URL', () => {
    const request = new Request('http://localhost:3000/api/chat', {
      headers: { origin: 'http://localhost:3000' },
    });
    expect(requestOriginMatches(request, undefined)).toBe(true);
  });

  it('rejects unrelated, null, and malformed origins', () => {
    for (const origin of ['https://attacker.example', 'null', 'not an origin', 'https://gensite.tech/path']) {
      const request = new Request('http://127.0.0.1:3000/api/chat', { headers: { origin } });
      expect(requestOriginMatches(request, 'https://gensite.tech')).toBe(false);
    }
  });

  it('keeps requests without an Origin header compatible with API clients', () => {
    expect(requestOriginMatches(new Request('http://127.0.0.1:3000/api/chat'), 'https://gensite.tech')).toBe(true);
  });
});
