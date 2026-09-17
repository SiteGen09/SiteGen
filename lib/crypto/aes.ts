import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Reads and validates the encryption key at call time. Never read at module load so that
 * importing this file cannot crash a process that will not encrypt anything.
 */
function loadKey(): Buffer {
  const encoded = process.env.ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error('ENCRYPTION_KEY is not set: expected a base64-encoded 32-byte key');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
} {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptSecret(ciphertext: Buffer, iv: Buffer, authTag: Buffer): string {
  const key = loadKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
