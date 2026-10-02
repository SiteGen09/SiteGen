import { createHash } from 'node:crypto';
import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { ApiError } from '@/lib/api/errors';

/**
 * Everything a media request points at besides its prompt: reference images,
 * source videos, and earlier jobs it extends.
 *
 * The safety check downloads each reference itself and judges the bytes. The
 * alternative, letting the classifier fetch the URL, fails badly: a model
 * that cannot reach an image describes one it imagined. The screened bytes
 * are then re-hosted and the provider is given that copy, so the URL cannot
 * be swapped for a different image after it passed.
 */

export interface UrlReference {
  /** Where the value sits in the input, for rewriting it. */
  path: (string | number)[];
  value: string;
}

export interface TaskReference {
  path: (string | number)[];
  key: string;
  value: string;
}

export interface CollectedInput {
  /** Every text value, for the rules and the classifier. */
  text: string;
  urls: UrlReference[];
  tasks: TaskReference[];
}

const URL_LIKE = /^(?:https?:\/\/|data:)/i;
const TASK_KEY = /(?:^|_)task_?id$|^taskid$|^(?:origin|source|parent)_?task_?id$/i;

/** Walks the input, sorting each string into text, a URL, or a job reference. */
export function collectInput(input: Record<string, unknown>): CollectedInput {
  const text: string[] = [];
  const urls: UrlReference[] = [];
  const tasks: TaskReference[] = [];
  const walk = (value: unknown, path: (string | number)[], key: string, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (URL_LIKE.test(trimmed)) urls.push({ path, value: trimmed });
      else if (TASK_KEY.test(key) && trimmed !== '') tasks.push({ path, key, value: trimmed });
      else if (trimmed !== '') text.push(key === 'prompt' ? trimmed : `${key}: ${trimmed}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, index], key, depth + 1));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) walk(child, [...path, childKey], childKey, depth + 1);
    }
  };
  walk(input, [], '', 0);
  return { text: text.join('\n'), urls, tasks };
}

/** A copy of `input` with the value at each path replaced. */
export function rewriteInput(input: Record<string, unknown>, replacements: ReadonlyArray<{ path: (string | number)[]; value: string }>): Record<string, unknown> {
  const copy = structuredClone(input);
  for (const { path, value } of replacements) {
    let target: Record<string | number, unknown> = copy;
    for (const segment of path.slice(0, -1)) target = target[segment] as Record<string | number, unknown>;
    target[path.at(-1)!] = value;
  }
  return copy;
}

// ── Download with an SSRF guard ─────────────────────────────────────────────

// Separate lists: Node matches IPv4 addresses against IPv4-mapped IPv6 rules,
// so one shared list would need care to avoid blocking every IPv4 host.
// Mapped addresses (::ffff:a.b.c.d) are unwrapped and checked as IPv4 instead.
const blockedV4 = new BlockList();
const blockedV6 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blockedV6.addSubnet(network, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return !blockedV4.check(mapped[1]!, 'ipv4');
  // Hex-form mapped addresses (::ffff:7f00:1) are refused rather than decoded.
  if (/^::ffff:/i.test(address)) return false;
  return !blockedV6.check(address, 'ipv6');
}

/**
 * Resolves like the system does, then refuses any private address. Used as the
 * socket's own lookup, so the address checked is the address connected to and
 * a DNS answer cannot change between the two.
 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = (Array.isArray(addresses) ? addresses : []) as { address: string; family: number }[];
    const bad = list.find((entry) => !isPublicAddress(entry.address));
    if (list.length === 0 || bad) {
      return callback(Object.assign(new Error('reference host resolves to a private address'), { code: 'EPRIVATE' }), '', 4);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

export interface Downloaded {
  bytes: Buffer;
  contentType: string;
}

function refused(message: string): ApiError {
  return new ApiError('invalid_request', message, 400);
}

function getOnce(url: URL, maxBytes: number, timeoutMs: number): Promise<{ status: number; location?: string; contentType: string; bytes?: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, {
      lookup: guardedLookup,
      headers: { 'user-agent': 'sitegen-safety/1.0', accept: 'image/*,video/*;q=0.9,*/*;q=0.1' },
      timeout: timeoutMs,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const contentType = String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      if (status >= 300 && status < 400) {
        response.resume();
        return resolve({ status, location: response.headers.location, contentType });
      }
      if (status !== 200) {
        response.resume();
        return resolve({ status, contentType });
      }
      if (Number(response.headers['content-length'] ?? 0) > maxBytes) {
        response.destroy();
        return reject(refused('a reference file is too large'));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          reject(refused('a reference file is too large'));
        } else chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, contentType, bytes: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('reference download timed out')));
    request.on('error', reject);
  });
}

/** Fetches a public http(s) reference, following at most three redirects. */
export async function downloadReference(raw: string, maxBytes: number, timeoutMs = 20_000): Promise<Downloaded> {
  if (/^data:/i.test(raw)) {
    const match = /^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=.+-]+)*;base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
    if (match === null) throw refused('a reference data URL is malformed');
    const bytes = Buffer.from(match[2]!, 'base64');
    if (bytes.length > maxBytes) throw refused('a reference file is too large');
    return { bytes, contentType: (match[1] ?? '').toLowerCase() };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refused('a reference URL is invalid');
  }
  for (let hop = 0; hop < 4; hop += 1) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw refused('reference URLs must use http or https');
    if (url.username || url.password) throw refused('reference URLs must not contain credentials');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !isPublicAddress(host)) throw refused('reference URLs must point to a public host');
    if (/^(?:localhost|.*\.(?:local|localhost|internal|lan|home|corp))$/i.test(host)) throw refused('reference URLs must point to a public host');
    let result;
    try {
      result = await getOnce(url, maxBytes, timeoutMs);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw refused((err as { code?: string }).code === 'EPRIVATE' ? 'reference URLs must point to a public host' : 'a reference file could not be downloaded');
    }
    if (result.location !== undefined) {
      url = new URL(result.location, url);
      continue;
    }
    if (result.bytes === undefined) throw refused(`a reference file could not be downloaded (HTTP ${result.status})`);
    return { bytes: result.bytes, contentType: result.contentType };
  }
  throw refused('a reference URL redirects too many times');
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** What the bytes actually are, whatever the server claimed. */
export function sniffKind(bytes: Buffer): 'image' | 'video' | 'audio' | null {
  if (bytes.length < 12) return null;
  const ascii = (start: number, end: number) => bytes.toString('latin1', start, end);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (/^(?:avif|avis|heic|heix|mif1|msf1)$/.test(brand)) return 'image';
    if (/^M4A/.test(brand)) return 'audio';
    return 'video';
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video';
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) || ascii(0, 4) === 'OggS' || ascii(0, 4) === 'fLaC' || (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE')) return 'audio';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image';
  return null;
}
