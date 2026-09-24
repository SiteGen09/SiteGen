import { z } from 'zod';
import { PROVIDERS } from '@/lib/ai/providers';

import type { ProviderCreds } from '@/lib/ai/provider';
import type { Provider } from '@/lib/ai/providers';
import { decryptSecret } from '@/lib/crypto/aes';
import { ApiError } from '@/lib/api/errors';
import { logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

/** supabase-js returns `bytea` as a `\x`-prefixed hex string. */
function decodeBytea(value: string): Buffer {
  const hex = value.startsWith('\\x') ? value.slice(2) : value;
  return Buffer.from(hex, 'hex');
}

const credentialRowSchema = z.object({
  provider: z.enum(PROVIDERS),
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
 * has none usable. The decrypted key is returned in-process only and must
 * never be logged.
 *
 * `provider` narrows the lookup to credentials that could actually serve the
 * call. It matters because decryption happens here, before any caller compares
 * providers: without it, a stored credential for some other provider — one
 * that would have been discarded a line later — is still decrypted, and a
 * malformed row then fails a request it had no part in.
 *
 * A row that cannot be decrypted is treated as absent rather than fatal. It is
 * unusable either way, so the only question is whether the call falls back to
 * the platform credential or dies; failing every request for one corrupt row
 * is the worse answer. It is logged at error level because a BYOK user
 * silently billed on the platform key deserves to be noticed.
 */
export async function getUserCredential(
  userId: string,
  provider?: Provider,
): Promise<ProviderCreds | null> {
  const service = createServiceClient();
  const query = service
    .from('provider_credentials')
    .select('provider, base_url, ciphertext, iv, auth_tag')
    .eq('owner_id', userId)
    .eq('status', 'active');

  const { data, error } = await (provider === undefined ? query : query.eq('provider', provider))
    .limit(1)
    .maybeSingle();

  if (error !== null) {
    throw new ApiError('internal_error', 'could not load provider credentials', 500);
  }
  if (data === null) return null;

  const parsed = credentialRowSchema.safeParse(data);
  if (!parsed.success) {
    logger({ request_id: `credentials:${userId}` }).error('byok.unreadable_row', {
      user_id: userId,
    });
    return null;
  }

  try {
    return decryptRow(parsed.data);
  } catch {
    logger({ request_id: `credentials:${userId}` }).error('byok.decrypt_failed', {
      user_id: userId,
      provider: parsed.data.provider,
    });
    return null;
  }
}
