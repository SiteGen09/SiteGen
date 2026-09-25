import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyKeyRouting,
  enforceKeyModel,
  enforceKeyQuota,
  ipAllowed,
  normalizeIpEntry,
  parseIpList,
  trustedClientIp,
  UNRESTRICTED_POLICY,
} from '@/lib/keys/key-policy';

describe('IP lists', () => {
  it('canonicalises addresses and ranges', () => {
    expect(normalizeIpEntry('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIpEntry('203.0.113.7/32')).toBe('203.0.113.7');
    expect(normalizeIpEntry('198.51.100.0/24')).toBe('198.51.100.0/24');
    expect(normalizeIpEntry('2001:DB8:0:0::1')).toBe('2001:db8::1');
    expect(normalizeIpEntry('2001:db8::/32')).toBe('2001:db8::/32');
  });

  it('rejects malformed entries', () => {
    for (const bad of ['', 'example.com', '10.0.0.256', '10.0.0.0/33', '10.0.0.0/', '10.0.0.0/8/8', '::1/129', '10.0.0.0/x'])
      expect(normalizeIpEntry(bad), bad).toBeNull();
  });

  it('splits free text and reports what did not parse', () => {
    expect(parseIpList('10.0.0.1, 10.0.0.1\n192.168.0.0/16  nope')).toEqual({
      entries: ['10.0.0.1', '192.168.0.0/16'],
      invalid: ['nope'],
    });
  });

  it('matches addresses and subnets of both families', () => {
    const allowed = ['203.0.113.7', '198.51.100.0/24', '2001:db8::/32'];
    expect(ipAllowed('203.0.113.7', allowed)).toBe(true);
    expect(ipAllowed('198.51.100.200', allowed)).toBe(true);
    expect(ipAllowed('2001:db8:1::5', allowed)).toBe(true);
    expect(ipAllowed('203.0.113.8', allowed)).toBe(false);
    expect(ipAllowed('2001:db9::1', allowed)).toBe(false);
    expect(ipAllowed(null, allowed)).toBe(false);
  });
});

describe('trustedClientIp', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reads only the configured proxy header', () => {
    vi.stubEnv('GUARD_TRUSTED_IP_HEADER', 'cf-connecting-ip');
    const headers = new Headers({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1' });
    expect(trustedClientIp(headers)).toBe('203.0.113.7');
  });

  it('knows no address when no trusted header is configured', () => {
    vi.stubEnv('GUARD_TRUSTED_IP_HEADER', '');
    expect(trustedClientIp(new Headers({ 'x-forwarded-for': '10.0.0.1' }))).toBeNull();
  });
});

describe('quota and models', () => {
  it('lets an unlimited key through', () => {
    expect(() => enforceKeyQuota(UNRESTRICTED_POLICY)).not.toThrow();
    expect(() => enforceKeyQuota(undefined)).not.toThrow();
  });

  it('refuses once the whole quota is charged', () => {
    expect(() => enforceKeyQuota({ ...UNRESTRICTED_POLICY, quotaCredits: 100, usedCredits: 99 })).not.toThrow();
    expect(() => enforceKeyQuota({ ...UNRESTRICTED_POLICY, quotaCredits: 100, usedCredits: 100 })).toThrow(
      expect.objectContaining({ code: 'insufficient_credits', status: 402 }),
    );
  });

  it('limits a key to its models', () => {
    const policy = { ...UNRESTRICTED_POLICY, allowedModels: ['gpt-5'] };
    expect(() => enforceKeyModel(policy, 'gpt-5')).not.toThrow();
    expect(() => enforceKeyModel(policy, 'claude-opus')).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => enforceKeyModel(UNRESTRICTED_POLICY, 'anything')).not.toThrow();
  });
});

describe('applyKeyRouting', () => {
  it('lays the key over the owner and leaves the rest alone', () => {
    const owner = new Map([['provider', 'kie.ai'], ['gpt:chat', 'kie-gpt'], ['claude:chat', 'kie-claude']]);
    const merged = applyKeyRouting(owner, {
      ...UNRESTRICTED_POLICY,
      routingProviderId: 'relay.fast',
      routingSources: { 'gpt:chat': 'relay-gpt' },
    });
    expect(Object.fromEntries(merged)).toEqual({
      provider: 'relay.fast',
      'gpt:chat': 'relay-gpt',
      'claude:chat': 'kie-claude',
    });
    expect(owner.get('provider')).toBe('kie.ai');
  });
});
