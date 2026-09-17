import { z } from 'zod';

import type { ProviderCreds } from '@/lib/ai/provider';
import { decryptSecret } from '@/lib/crypto/aes';
import { ApiError } from '@/lib/api/errors';
import { createServiceClient } from '@/lib/supabase/service';

/** supabase-js returns `bytea` as a `\x`-prefixed hex string. */
function decodeBytea(value: string): Buffer {
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  return Buffer.from(hex, 'hex');
}

const credentialRowSchema = z.object({
  provider: z.enum(['anthropic', 'openai_compatible']),
  base_url: z.string().nullable(),
  ciphertext: z.string(),
  iv: z.string(),
  auth_tag: z.string(),
});

function decryptRow(row: z.infer<typeof credentialRowSchema>): ProviderCreds {
  const apiKey = decryptSecret(
    decodeBytea(row.ciphertext),
    decodeBytea(row.iv),
    decodeBytea(row.auth_tag),
  );
  return { provider: row.provider, apiKey, baseUrl: row.base_url };
}

/**
 * Active provider credential owned by `userId` (BYOK), or `null` when the user
 * has none. The decrypted key is returned in-process only and must never be
 * logged.
 */
export async function getUserCredential(userId: string): Promise<ProviderCreds | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('provider_credentials')
    .select('provider, base_url, ciphertext, iv, auth_tag')
    .eq('owner_id', userId)
    .eq('status', 'active')
    .limit(1)
    .maybeSingle();

  if (error !== null) {
    throw new ApiError('internal_error', 'could not load provider credentials', 500);
  }
  if (data === null) return null;

  return decryptRow(credentialRowSchema.parse(data));
}

/**
 * Platform credentials for `provider`: the shared credential row with
 * `owner_id IS NULL`, or — only for Anthropic — the `ANTHROPIC_API_KEY`
 * environment fallback when no platform row exists. Throws
 * `channel_unavailable` when neither is configured.
 */
export async function getPlatformCreds(
  provider: 'anthropic' | 'openai_compatible',
  baseUrl: string | null,
): Promise<ProviderCreds> {
  const service = createServiceClient();
  
  // Match by provider AND base_url to support multiple openai_compatible providers
  const query = service
    .from('provider_credentials')
    .select('provider, base_url, ciphertext, iv, auth_tag')
    .is('owner_id', null)
    .eq('provider', provider)
    .eq('status', 'active');
  
  // For openai_compatible, base_url is required and must match exactly
  // For anthropic, base_url match is optional (null matches null)
  if (baseUrl !== null) {
    query.eq('base_url', baseUrl);
  } else {
    query.is('base_url', null);
  }
  
  const { data, error } = await query.limit(1).maybeSingle();

  if (error !== null) {
    throw new ApiError('internal_error', 'could not load platform credentials', 500);
  }
  if (data !== null) {
    return decryptRow(credentialRowSchema.parse(data));
  }

  const envKey = process.env.ANTHROPIC_API_KEY;
  if (provider === 'anthropic' && envKey !== undefined && envKey.length > 0) {
    return { provider: 'anthropic', apiKey: envKey, baseUrl };
  }

  throw new ApiError('channel_unavailable', 'no platform credentials configured', 503);
}
