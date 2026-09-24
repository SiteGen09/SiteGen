import { describe, expect, it } from 'vitest';

import {
  acceptsBaseUrl,
  isProvider,
  PROVIDERS,
  PROVIDER_ENDPOINT_PATH,
  PROVIDER_LABELS,
  requiresBaseUrl,
} from '@/lib/ai/providers';

describe('provider list', () => {
  it('carries a label for every kind, so no UI can render a raw enum value', () => {
    for (const provider of PROVIDERS) {
      expect(PROVIDER_LABELS[provider]).toBeTruthy();
    }
  });

  it('accepts only known kinds', () => {
    expect(isProvider('anthropic_compatible')).toBe(true);
    expect(isProvider('anthropic-compatible')).toBe(false);
    expect(isProvider('openai')).toBe(false);
    expect(isProvider(null)).toBe(false);
  });

  it('carries an endpoint path for every kind, so the forms never omit one', () => {
    for (const provider of PROVIDERS) {
      expect(PROVIDER_ENDPOINT_PATH[provider]).toMatch(/^\//);
    }
  });

  /**
   * The two OpenAI kinds exist only to distinguish these two paths; a gateway
   * may serve one and 404 the other. If they ever collapsed to one value the
   * separate kinds would be pointless and the forms would mislead.
   */
  it('separates the OpenAI kinds by endpoint', () => {
    expect(PROVIDER_ENDPOINT_PATH.openai_compatible).toBe('/chat/completions');
    expect(PROVIDER_ENDPOINT_PATH.openai_responses).toBe('/responses');
  });

  it('gives both Anthropic kinds the same path, since they differ by host', () => {
    expect(PROVIDER_ENDPOINT_PATH.anthropic).toBe('/messages');
    expect(PROVIDER_ENDPOINT_PATH.anthropic_compatible).toBe('/messages');
  });
});

describe('base URL rules', () => {
  it('requires a gateway for both compatible kinds', () => {
    expect(requiresBaseUrl('anthropic_compatible')).toBe(true);
    expect(requiresBaseUrl('openai_compatible')).toBe(true);
  });

  /**
   * The first party is pinned to its own host by `buildAI`, so a base URL
   * stored against it would be silently inert — the failure that sent a relay
   * key to api.anthropic.com before `anthropic_compatible` existed.
   */
  it('neither requires nor accepts a base URL on the first-party kind', () => {
    expect(requiresBaseUrl('anthropic')).toBe(false);
    expect(acceptsBaseUrl('anthropic')).toBe(false);
  });
});
