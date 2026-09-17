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

export const PROVIDERS = ['anthropic', 'openai_compatible'] as const;
export type Provider = (typeof PROVIDERS)[number];

const credentialRowSchema = z.object({
  base_url: z.string().nullable(),
  ciphertext: z.unknown(),
  iv: z.unknown(),
  auth_tag: z.unknown(),
});

/**
 * Resolves the credential a platform channel calls with.
 *
 * Prefers the newest active platform row for the provider. When no such row
 * exists we fall back to `ANTHROPIC_API_KEY` from the environment so a fresh
 * deployment can serve Anthropic traffic before an admin has stored a key;
 * there is deliberately no env fallback for `openai_compatible`, which has no
 * single well-known key.
 *
 * `channelBaseUrl` wins over the credential's stored base URL: the channel
 * decides which endpoint it targets.
 */
export async function resolvePlatformCreds(
  provider: Provider,
  channelBaseUrl: string | null,
): Promise<ProviderCreds> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('provider_credentials')
    .select('base_url, ciphertext, iv, auth_tag')
    .is('owner_id', null)
    .eq('provider', provider)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error !== null) {
    throw new ApiError('internal_error', 'failed to load platform credential', 500);
  }

  const parsed = credentialRowSchema.safeParse(data as unknown);
  if (parsed.success) {
    const apiKey = decryptSecret(
      fromByteaHex(parsed.data.ciphertext),
      fromByteaHex(parsed.data.iv),
      fromByteaHex(parsed.data.auth_tag),
    );
    return { provider, apiKey, baseUrl: channelBaseUrl ?? parsed.data.base_url };
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
