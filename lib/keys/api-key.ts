import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_PREFIX = 'sk_live_';
const SECRET_BYTES = 32;
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE62_RADIX = BigInt(BASE62_ALPHABET.length);
/** Chars needed to hold 2^256 in base62: ceil(256 / log2(62)) === 43. */
const BASE62_LENGTH = 43;

function encodeBase62(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (value > 0n) {
    out = BASE62_ALPHABET.charAt(Number(value % BASE62_RADIX)) + out;
    value /= BASE62_RADIX;
  }
  return out.padStart(BASE62_LENGTH, '0');
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateApiKey(): {
  key: string;
  hash: string;
  prefix: string;
  lastFour: string;
} {
  const key = `${KEY_PREFIX}${encodeBase62(randomBytes(SECRET_BYTES))}`;
  return {
    key,
    hash: hashApiKey(key),
    prefix: key.slice(0, 8),
    lastFour: key.slice(-4),
  };
}

/** Constant-time comparison of two hex digests. Returns false on length mismatch. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
