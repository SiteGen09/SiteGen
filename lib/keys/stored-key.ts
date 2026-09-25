import { toByteaHex, fromByteaHex } from '@/lib/admin/credentials';
import { decryptSecret, encryptSecret } from '@/lib/crypto/aes';

/**
 * The encrypted copy of an API key that lets its owner copy it again.
 * Server-only: encrypts and decrypts with ENCRYPTION_KEY.
 */

export interface StoredKeyColumns {
  key_ciphertext: string;
  key_iv: string;
  key_auth_tag: string;
}

export function encryptApiKey(key: string): StoredKeyColumns {
  const { ciphertext, iv, authTag } = encryptSecret(key);
  return { key_ciphertext: toByteaHex(ciphertext), key_iv: toByteaHex(iv), key_auth_tag: toByteaHex(authTag) };
}

/** Null when the key predates copyable keys and has no stored copy. */
export function decryptApiKey(row: {
  key_ciphertext: unknown;
  key_iv: unknown;
  key_auth_tag: unknown;
}): string | null {
  if (row.key_ciphertext == null || row.key_iv == null || row.key_auth_tag == null) return null;
  return decryptSecret(fromByteaHex(row.key_ciphertext), fromByteaHex(row.key_iv), fromByteaHex(row.key_auth_tag));
}
