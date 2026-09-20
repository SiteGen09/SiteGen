import { describe, expect, it } from 'vitest';

import {
  acceptsBaseUrl,
  isProvider,
  PROVIDERS,
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
