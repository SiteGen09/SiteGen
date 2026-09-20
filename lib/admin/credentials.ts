import { z } from 'zod';

import { ApiError } from '@/lib/api/errors';
import { decryptSecret } from '@/lib/crypto/aes';
import type { ProviderCreds } from '@/lib/ai/provider';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Platform provider credentials (`provider_credentials` rows with a NULL
 * `owner_id`). Server-only: decrypts secret material.
 */

/** supabase-js sends and receives `bytea` as a `\x`-prefixed hex string. */
export function toByteaHex(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

export function fromByteaHex(value: unknown): Buffer {
  if (typeof value === 'string') {
    const hex = value.startsWith('\\x') ? value.slice(2) : value;
    return Buffer.from(hex, 'hex');
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  throw new ApiError('internal_error', 'unexpected bytea encoding', 500);
}

import type { Provider } from '@/lib/ai/providers';

/**
 * Re-exported so callers already importing the credential helpers keep one
 * import; `@/lib/ai/providers` remains the definition.
 */
export { PROVIDERS, type Provider } from '@/lib/ai/providers';

const credentialRowSchema = z.object({
  base_url: z.string().nullable(),
  ciphertext: z.unknown(),
  iv: z.unknown(),
  auth_tag: z.unknown(),
  created_at: z.union([z.string(), z.date()]).transform((value) =>
    value instanceof Date ? value.getTime() : Date.parse(value),
  ),
});

/**
 * Normalizes a base URL for comparison: `NULL` and `''` are the same absence
 * of a URL, and a trailing slash is cosmetic. Without this, a channel pointing
 * at `https://x/v1/` would silently match zero credential rows while an
 * identical channel with `https://x/v1` matched one.
 */
function canonicalBaseUrl(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Resolves the credential a platform channel calls with.
 *
 * Matching on provider AND base URL is what keeps multiple compatible
 * upstreams (kie.ai, OpenRouter, z.ai, an Anthropic relay…) from sharing one
 * key: provider alone would hand kie.ai's key to a request aimed at z.ai, so
 * the admin "Test" button could pass while the live call failed.
 *
 * The newest active matching row wins, so rotating a key is an insert.
 * `ANTHROPIC_API_KEY` remains a fallback so a fresh deployment can serve
 * first-party Anthropic traffic before an admin has stored a key. Neither
 * compatible kind has an env fallback: a gateway is identified by its base
 * URL, so there is no single well-known key to fall back to.
 *
 * `channelBaseUrl` wins over the credential's stored base URL: the channel
 * decides which endpoint it targets.
 */
export async function resolvePlatformCreds(
  provider: Provider,
  channelBaseUrl: string | null,
): Promise<ProviderCreds> {
  const service = createServiceClient();

  const query = service
    .from('provider_credentials')
    .select('base_url, ciphertext, iv, auth_tag, created_at')
    .is('owner_id', null)
    .eq('provider', provider)
    .eq('status', 'active');

  // PostgREST cannot compare on a normalized expression, so both spellings of
  // the same URL are requested; the newest match wins so rotating a key is an
  // insert rather than an update.
  const canonical = canonicalBaseUrl(channelBaseUrl);
  const scoped =
    canonical === null
      ? query.or('base_url.is.null,base_url.eq.')
      : query.in('base_url', [canonical, `${canonical}/`]);
  const { data, error } = await scoped
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error !== null) {
    throw new ApiError('internal_error', 'failed to load platform credential', 500);
  }

  const parsed = credentialRowSchema.safeParse(data);
  if (parsed.success) {
    const row = parsed.data;
    const apiKey = decryptSecret(
      fromByteaHex(row.ciphertext),
      fromByteaHex(row.iv),
      fromByteaHex(row.auth_tag),
    );
    return { provider, apiKey, baseUrl: canonical ?? row.base_url };
  }

  const envKey = process.env.ANTHROPIC_API_KEY;
  if (provider === 'anthropic' && envKey !== undefined && envKey.length > 0) {
    return { provider, apiKey: envKey, baseUrl: channelBaseUrl };
  }

  throw new ApiError(
    'channel_unavailable',
    `no active platform credential for provider '${provider}'`,
    503,
  );
}
