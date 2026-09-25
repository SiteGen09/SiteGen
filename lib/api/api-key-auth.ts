import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { ApiError } from '@/lib/api/errors';
import { hashApiKey, timingSafeEqualHex } from '@/lib/keys/api-key';
import { ipAllowed, trustedClientIp, UNRESTRICTED_POLICY, type KeyPolicy } from '@/lib/keys/key-policy';
import type { Logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

const BEARER_PREFIX = 'Bearer ';
const KEY_PREFIX = 'sk_live_';
/**
 * Bounds on the secret that follows {@link KEY_PREFIX}. `generateApiKey` emits
 * 43 base62 characters; the range keeps obviously malformed input from reaching
 * the database without pinning the format to one generator revision.
 */
const MIN_SECRET_CHARS = 32;
const MAX_SECRET_CHARS = 64;

export interface AuthenticatedKey {
  apiKeyId: string;
  ownerId: string;
  rateLimitRpm: number;
  scopes: string[];
  policy: KeyPolicy;
}

/**
 * Row shape read back for verification. Parsed rather than trusted because the
 * Supabase client is untyped, so `data` would otherwise be implicitly `any`.
 */
const apiKeyRowSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  key_hash: z.string(),
  scopes: z.array(z.string()),
  status: z.string(),
  rate_limit_rpm: z.number().int(),
  revoked_at: z.string().nullable(),
  /**
   * Embedded owner row. PostgREST returns an object for a to-one embed and
   * `null` when the profile is missing; both are handled rather than assumed.
   */
  profiles: z.object({ status: z.string(), billing_hold: z.boolean().optional() }).nullable(),
  // Per-key settings. Optional so a database that has not yet run
  // 20260925150000_api_key_settings keeps authenticating unrestricted keys.
  expires_at: z.string().nullish(),
  quota_credits: z.coerce.number().nullish(),
  used_credits: z.coerce.number().nullish(),
  allowed_models: z.array(z.string()).nullish(),
  allowed_ips: z.array(z.string()).nullish(),
  routing_provider_id: z.string().nullish(),
  routing_sources: z.record(z.string(), z.string()).nullish(),
});

const BASE_COLUMNS =
  'id, owner_id, key_hash, scopes, status, rate_limit_rpm, revoked_at, profiles(status,billing_hold)';
const POLICY_COLUMNS =
  'expires_at, quota_credits, used_credits, allowed_models, allowed_ips, routing_provider_id, routing_sources';
/** Postgres "undefined column": the settings migration has not been applied. */
const UNDEFINED_COLUMN = '42703';

/**
 * One message for every rejection reason. Distinguishing "no such key" from
 * "revoked key" would let a caller probe which hashes exist.
 */
function unauthorized(): ApiError {
  return new ApiError('unauthorized', 'invalid or missing API key', 401);
}


/** Extracts the raw key from an `Authorization` header, or throws `unauthorized`. */
export function parseBearerKey(authHeader: string | null): string {
  if (authHeader === null || !authHeader.startsWith(BEARER_PREFIX)) throw unauthorized();

  const key = authHeader.slice(BEARER_PREFIX.length).trim();
  if (!key.startsWith(KEY_PREFIX)) throw unauthorized();

  const secretLength = key.length - KEY_PREFIX.length;
  if (secretLength < MIN_SECRET_CHARS || secretLength > MAX_SECRET_CHARS) throw unauthorized();

  return key;
}

/**
 * Records that a key was used. Deliberately not awaited: `last_used_at` is
 * telemetry, and a slow or failing write must not delay or fail the request.
 */
function touchLastUsed(service: SupabaseClient, apiKeyId: string, log?: Logger): void {
  void Promise.resolve(
    service
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', apiKeyId),
  ).then(
    ({ error }) => {
      if (error !== null) {
        log?.warn('api_key.last_used_update_failed', { api_key_id: apiKeyId, db_error: error.code });
      }
    },
    (err: unknown) => {
      log?.warn('api_key.last_used_update_failed', {
        api_key_id: apiKeyId,
        db_error: err instanceof Error ? err.message : String(err),
      });
    },
  );
}

/**
 * Verifies a `Bearer sk_live_...` credential against `api_keys`.
 *
 * The lookup is a single indexed query on the SHA-256 hash of the presented
 * key, so no plaintext or per-row comparison loop is involved. The returned
 * hash is still compared constant-time against the computed one, which keeps
 * verification independent of how the row was reached.
 */
export async function authenticateApiKey(
  authHeader: string | null,
  log?: Logger,
  request?: Request,
): Promise<AuthenticatedKey> {
  const key = parseBearerKey(authHeader);
  const keyHash = hashApiKey(key);
  const service = createServiceClient();

  const lookup = (columns: string) =>
    service.from('api_keys').select(columns).eq('key_hash', keyHash).maybeSingle();
  let { data, error } = await lookup(`${BASE_COLUMNS}, ${POLICY_COLUMNS}`);
  if (error?.code === UNDEFINED_COLUMN) ({ data, error } = await lookup(BASE_COLUMNS));

  if (error !== null) {
    log?.error('api_key.lookup_failed', { db_error: error.code });
    throw new ApiError('internal_error', 'could not verify credentials', 500);
  }
  if (data === null) throw unauthorized();

  const row = apiKeyRowSchema.parse(data);
  if (!timingSafeEqualHex(row.key_hash, keyHash)) throw unauthorized();
  if (row.status !== 'active' || row.revoked_at !== null) throw unauthorized();
  if (row.expires_at != null && Date.parse(row.expires_at) <= Date.now()) throw unauthorized();

  // The kill switch: one check here covers every present and future endpoint,
  // since all of them authenticate through this function. The message stays
  // generic so a caller cannot tell suspension from a bad key.
  if (row.profiles?.status !== 'active' || row.profiles?.billing_hold === true) {
    log?.warn('api_key.suspended', { api_key_id: row.id });
    throw new ApiError('forbidden', 'invalid or missing API key', 403);
  }

  // Checked after suspension so an owner cannot learn their account state by
  // calling from an unlisted address. Fails closed: with no trusted address
  // header the caller's IP is unknown, and a restricted key is refused.
  if (row.allowed_ips != null) {
    const ip = request === undefined ? null : trustedClientIp(request.headers);
    if (!ipAllowed(ip, row.allowed_ips)) {
      log?.warn('api_key.ip_refused', { api_key_id: row.id });
      throw new ApiError('forbidden', 'this API key may not be used from this IP address', 403);
    }
  }

  touchLastUsed(service, row.id, log);

  return {
    apiKeyId: row.id,
    ownerId: row.owner_id,
    rateLimitRpm: row.rate_limit_rpm,
    scopes: row.scopes,
    policy: {
      ...UNRESTRICTED_POLICY,
      quotaCredits: row.quota_credits ?? null,
      usedCredits: row.used_credits ?? 0,
      allowedModels: row.allowed_models ?? null,
      routingProviderId: row.routing_provider_id ?? null,
      routingSources: row.routing_sources ?? {},
    },
  };
}

/** Throws `forbidden` when the key was not granted `scope`. */
export function requireScope(auth: AuthenticatedKey, scope: string): void {
  if (!auth.scopes.includes(scope)) {
    throw new ApiError('forbidden', `API key is missing the '${scope}' scope`, 403);
  }
}
