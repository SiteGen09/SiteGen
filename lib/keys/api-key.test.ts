import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, timingSafeEqualHex } from './api-key';

describe('generateApiKey', () => {
  it('produces a sk_live_ prefixed base62 key', () => {
    const { key } = generateApiKey();
    expect(key).toMatch(/^sk_live_[0-9A-Za-z]+$/);
  });

  it('hashes the full key with sha256', () => {
    const { key, hash } = generateApiKey();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashApiKey(key));
    expect(hash).toBe(createHash('sha256').update(key, 'utf8').digest('hex'));
  });

  it('exposes the first eight chars as prefix and the final four as lastFour', () => {
    const { key, prefix, lastFour } = generateApiKey();
    expect(prefix).toHaveLength(8);
    expect(prefix).toBe(key.slice(0, 8));
    expect(lastFour).toHaveLength(4);
    expect(lastFour).toBe(key.slice(-4));
  });

  it('generates distinct keys', () => {
    const first = generateApiKey();
    const second = generateApiKey();
    expect(first.key).not.toBe(second.key);
    expect(first.hash).not.toBe(second.hash);
  });
});

describe('timingSafeEqualHex', () => {
  it('matches identical digests', () => {
    const hash = hashApiKey('sk_live_abc');
    expect(timingSafeEqualHex(hash, hash)).toBe(true);
  });

  it('rejects different digests of equal length', () => {
    expect(timingSafeEqualHex(hashApiKey('a'), hashApiKey('b'))).toBe(false);
  });

  it('returns false on length mismatch without throwing', () => {
    expect(timingSafeEqualHex(hashApiKey('a'), 'deadbeef')).toBe(false);
    expect(timingSafeEqualHex('', hashApiKey('a'))).toBe(false);
  });
});
