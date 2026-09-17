import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './aes';

process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret', () => {
    const plaintext = 'anthropic-api-key-value-\u00e9\u2713';
    const { ciphertext, iv, authTag } = encryptSecret(plaintext);
    expect(decryptSecret(ciphertext, iv, authTag)).toBe(plaintext);
  });

  it('uses a fresh 12-byte iv per call', () => {
    const first = encryptSecret('same-input');
    const second = encryptSecret('same-input');
    expect(first.iv).toHaveLength(12);
    expect(second.iv).toHaveLength(12);
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('rejects a tampered auth tag', () => {
    const { ciphertext, iv, authTag } = encryptSecret('tamper-me');
    const forged = Buffer.from(authTag);
    forged[0] = forged[0]! ^ 0x01;
    expect(() => decryptSecret(ciphertext, iv, forged)).toThrow();
  });

  it('rejects tampered ciphertext', () => {
    const { ciphertext, iv, authTag } = encryptSecret('tamper-me');
    const forged = Buffer.from(ciphertext);
    forged[0] = forged[0]! ^ 0x01;
    expect(() => decryptSecret(forged, iv, authTag)).toThrow();
  });

  it('throws when the key is the wrong length', () => {
    const valid = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = Buffer.alloc(16, 7).toString('base64');
    try {
      expect(() => encryptSecret('nope')).toThrow(/exactly 32 bytes/);
    } finally {
      process.env.ENCRYPTION_KEY = valid;
    }
  });

  it('throws when the key is missing', () => {
    const valid = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(() => encryptSecret('nope')).toThrow(/ENCRYPTION_KEY is not set/);
    } finally {
      process.env.ENCRYPTION_KEY = valid;
    }
  });
});
