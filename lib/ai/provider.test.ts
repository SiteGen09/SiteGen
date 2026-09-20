import { describe, expect, it } from 'vitest';

import { buildAI, providerEndpoint } from '@/lib/ai/provider';

/**
 * These assertions pin the rule the admin UI reports: `buildAI` builds the
 * Anthropic provider without a `baseURL`, so a base URL stored against
 * provider `anthropic` is inert. If that ever changes, this fails loudly
 * rather than letting the UI quietly report the wrong endpoint.
 */
describe('providerEndpoint', () => {
  it('reports the fixed Anthropic endpoint', () => {
    expect(providerEndpoint({ provider: 'anthropic', apiKey: 'k' })).toBe(
      'https://api.anthropic.com/v1',
    );
  });

  it('ignores a base URL set against anthropic, matching buildAI', () => {
    expect(
      providerEndpoint({ provider: 'anthropic', apiKey: 'k', baseUrl: 'https://relay.example/v1' }),
    ).toBe('https://api.anthropic.com/v1');
  });

  it('reports the base URL for openai_compatible', () => {
    expect(
      providerEndpoint({
        provider: 'openai_compatible',
        apiKey: 'k',
        baseUrl: '  https://relay.example/v1  ',
      }),
    ).toBe('https://relay.example/v1');
  });

  it('names the absence of a base URL rather than printing an empty string', () => {
    expect(providerEndpoint({ provider: 'openai_compatible', apiKey: 'k', baseUrl: null })).toBe(
      '(no base URL)',
    );
  });

  it('reports the gateway for anthropic_compatible, not Anthropic', () => {
    expect(
      providerEndpoint({
        provider: 'anthropic_compatible',
        apiKey: 'k',
        baseUrl: 'https://relay.example/v1',
      }),
    ).toBe('https://relay.example/v1');
  });
});

describe('buildAI', () => {
  it('builds every provider kind that carries what it needs', () => {
    expect(() => buildAI({ provider: 'anthropic', apiKey: 'k' })).not.toThrow();
    expect(() =>
      buildAI({ provider: 'anthropic_compatible', apiKey: 'k', baseUrl: 'https://relay/v1' }),
    ).not.toThrow();
    expect(() =>
      buildAI({ provider: 'openai_compatible', apiKey: 'k', baseUrl: 'https://relay/v1' }),
    ).not.toThrow();
  });

  it('refuses a compatible provider with no gateway to call', () => {
    expect(() => buildAI({ provider: 'anthropic_compatible', apiKey: 'k' })).toThrow(
      /requires a baseUrl/,
    );
    expect(() => buildAI({ provider: 'openai_compatible', apiKey: 'k', baseUrl: '   ' })).toThrow(
      /requires a baseUrl/,
    );
  });
});
