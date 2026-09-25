import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { generateApiKey } from './api-key';
import { decryptApiKey, encryptApiKey } from './stored-key';

const previous = process.env.ENCRYPTION_KEY;
beforeEach(() => { process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64'); });
afterEach(() => { process.env.ENCRYPTION_KEY = previous; });

it('round-trips a key through the bytea columns without storing the plaintext', () => {
  const { key } = generateApiKey();
  const columns = encryptApiKey(key);
  for (const value of Object.values(columns)) {
    expect(value).toMatch(/^\\x[0-9a-f]+$/);
    expect(value).not.toContain(Buffer.from(key).toString('hex'));
  }
  expect(decryptApiKey(columns)).toBe(key);
});

it('returns null for keys created before copies were stored', () => {
  expect(decryptApiKey({ key_ciphertext: null, key_iv: null, key_auth_tag: null })).toBeNull();
});

it('rejects a tampered copy', () => {
  const columns = encryptApiKey(generateApiKey().key);
  const flipped = columns.key_ciphertext.slice(0, -1) + (columns.key_ciphertext.endsWith('0') ? '1' : '0');
  expect(() => decryptApiKey({ ...columns, key_ciphertext: flipped })).toThrow();
});
