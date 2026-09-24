import { describe, expect, it } from 'vitest';
import {
  publicRoutingProviderIdentity,
  publicRoutingProviderIdentityFromIdentity,
  publicRoutingProviderLabel,
  publicRoutingSourceLabel,
  publicRoutingText,
} from './routing-provider';

const names = new Map([['kie.ai', 'Budget Cloud']]);

describe('routing provider display names', () => {
  it('renames the label but keeps the stable public id', () => {
    expect(publicRoutingProviderIdentity({ baseUrl: 'https://api.kie.ai/v1' }, names))
      .toEqual({ id: 'provider-b', label: 'Budget Cloud' });
    expect(publicRoutingProviderIdentity({ baseUrl: 'https://relay.fast/v1' }, names))
      .toEqual({ id: 'provider-a', label: 'Provider A' });
  });

  it('keeps the built-in aliases without names', () => {
    expect(publicRoutingProviderIdentity({ baseUrl: 'https://api.kie.ai/v1' }))
      .toEqual({ id: 'provider-b', label: 'Provider B' });
    expect(publicRoutingProviderLabel('kie.ai')).toBe('Provider B');
  });

  it('renames a provider without an alias under its own host id', () => {
    const host = new Map([['api.other.example', 'Other']]);
    expect(publicRoutingProviderIdentityFromIdentity({ id: 'api.other.example', label: 'api.other.example' }, host))
      .toEqual({ id: 'api.other.example', label: 'Other' });
  });

  it('applies the name to usage history labels and free text', () => {
    expect(publicRoutingSourceLabel('kie.ai gpt chat', names)).toBe('Budget Cloud');
    expect(publicRoutingText('kie.ai chat models from gpt', names)).toBe('Budget Cloud chat models from gpt');
  });

  it('inserts a display name literally, even with replacement patterns', () => {
    expect(publicRoutingText('via kie.ai', new Map([['kie.ai', 'Cost $& Co']]))).toBe('via Cost $& Co');
  });
});
