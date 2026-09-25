import { BlockList, isIP } from 'node:net';

import { ApiError } from '@/lib/api/errors';
import { PROVIDER_PREFERENCE_KEY, type RoutingPreferences } from '@/lib/ai/source-types';

/**
 * The limits and routing overrides a consumer set on one API key. Enforced on
 * every request made with that key; a dashboard session has none.
 */
export interface KeyPolicy {
  /** Spending limit in credits; null is unlimited. */
  quotaCredits: number | null;
  usedCredits: number;
  /** Public model ids the key may call; null allows every model. */
  allowedModels: string[] | null;
  /** Internal provider identity Auto starts on for this key, over the owner's. */
  routingProviderId: string | null;
  /** `family:modality` → internal source id, over the owner's choices. */
  routingSources: Record<string, string>;
}

export const UNRESTRICTED_POLICY: KeyPolicy = {
  quotaCredits: null,
  usedCredits: 0,
  allowedModels: null,
  routingProviderId: null,
  routingSources: {},
};

export const MAX_ALLOWED_IPS = 100;

/**
 * Parses one IP or CIDR entry into its canonical text, or null when invalid.
 * A bare address becomes a /32 or /128 so matching has a single shape.
 */
export function normalizeIpEntry(raw: string): string | null {
  const value = raw.trim();
  const [address = '', prefixText, extra] = value.split('/');
  if (extra !== undefined) return null;
  const family = isIP(address);
  if (family === 0) return null;
  const max = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!/^\d+$/.test(prefixText ?? String(max)) || !Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  const canonical = family === 6 ? new URL(`http://[${address}]`).hostname.slice(1, -1) : address;
  return prefix === max ? canonical : `${canonical}/${prefix}`;
}

/**
 * Splits a free-text list (commas, spaces or new lines) into canonical
 * entries. Returns the entries that failed to parse so the form can name them.
 */
export function parseIpList(text: string): { entries: string[]; invalid: string[] } {
  const entries: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    const entry = normalizeIpEntry(raw);
    if (entry === null) invalid.push(raw);
    else if (!entries.includes(entry)) entries.push(entry);
  }
  return { entries, invalid };
}

/** Whether `ip` falls inside any of the stored, already-canonical entries. */
export function ipAllowed(ip: string | null, allowed: readonly string[]): boolean {
  if (ip === null) return false;
  const family = isIP(ip);
  if (family === 0) return false;
  const list = new BlockList();
  for (const entry of allowed) {
    const [address = '', prefix] = entry.split('/');
    const type = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * The caller's address, read only from the proxy-controlled header the
 * deployment names (Cloudflare's `cf-connecting-ip` in production). An
 * arbitrary X-Forwarded-For is spoofable, so with no trusted header configured
 * the address is unknown and an IP-restricted key is refused.
 */
export function trustedClientIp(headers: Headers): string | null {
  const header = process.env.VERCEL === '1' ? 'x-vercel-forwarded-for' : process.env.GUARD_TRUSTED_IP_HEADER;
  if (!header) return null;
  const ip = headers.get(header)?.split(',')[0]?.trim();
  return ip && isIP(ip) ? ip : null;
}

/**
 * Refuses a key whose limit is spent. The check is on what has been charged,
 * not on the next request's estimate, so the request that crosses the limit
 * completes and the next one is refused.
 */
export function enforceKeyQuota(policy: KeyPolicy | undefined): void {
  if (policy?.quotaCredits == null) return;
  if (policy.usedCredits >= policy.quotaCredits) {
    throw new ApiError('insufficient_credits', 'this API key has used its whole quota', 402);
  }
}

export function enforceKeyModel(policy: KeyPolicy | undefined, model: string): void {
  if (policy?.allowedModels == null) return;
  if (!policy.allowedModels.includes(model)) {
    throw new ApiError('forbidden', `this API key is not allowed to use the model '${model}'`, 403);
  }
}

/** The owner's routing preferences with this key's overrides laid over them. */
export function applyKeyRouting(
  preferences: RoutingPreferences,
  policy: KeyPolicy | undefined,
): RoutingPreferences {
  if (policy === undefined) return preferences;
  const merged = new Map(preferences);
  if (policy.routingProviderId !== null) merged.set(PROVIDER_PREFERENCE_KEY, policy.routingProviderId);
  for (const [key, sourceId] of Object.entries(policy.routingSources)) merged.set(key, sourceId);
  return merged;
}
