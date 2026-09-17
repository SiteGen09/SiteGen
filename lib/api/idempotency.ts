import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { ApiError } from '@/lib/api/errors';
import { createServiceClient } from '@/lib/supabase/service';

/** Postgres `unique_violation`, raised when the reservation already exists. */
const PG_UNIQUE_VIOLATION = '23505';

export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** What a handler produces: the status and JSON body it wants to return. */
export interface IdempotentResponse {
  status: number;
  body: unknown;
}

export interface IdempotentOutcome extends IdempotentResponse {
  /** True when this response was stored by an earlier attempt, not produced now. */
  replay: boolean;
}

const storedRowSchema = z.object({
  request_hash: z.string(),
  status: z.string(),
  response_status: z.number().int().nullable(),
  response_body: z.unknown(),
});

function storeUnavailable(): ApiError {
  return new ApiError('internal_error', 'idempotency store unavailable', 500);
}

function conflict(message: string): ApiError {
  return new ApiError('idempotency_conflict', message, 409);
}

/**
 * Drops the reservation so the same key can be retried. Failure to delete is
 * not surfaced: the caller is already returning an error, and a stranded
 * `in_progress` row degrades to a 409 rather than to a wrong answer.
 */
async function discard(service: SupabaseClient, userId: string, key: string): Promise<void> {
  await service.from('idempotency_keys').delete().eq('key', key).eq('user_id', userId);
}

async function replayExisting(
  service: SupabaseClient,
  userId: string,
  key: string,
  requestHash: string,
): Promise<IdempotentOutcome> {
  const { data, error } = await service
    .from('idempotency_keys')
    .select('request_hash, status, response_status, response_body')
    .eq('key', key)
    .eq('user_id', userId)
    .maybeSingle();

  if (error !== null) throw storeUnavailable();
  if (data === null) {
    // The row was discarded between our conflict and this read, i.e. a
    // concurrent attempt failed with a 5xx. Treat as a live duplicate.
    throw conflict('a request with this idempotency key is still in progress');
  }

  const row = storedRowSchema.parse(data);

  // A key is bound to the body it was first used with, regardless of how far
  // that first attempt got.
  if (row.request_hash !== requestHash) {
    throw conflict('idempotency key was already used with a different request body');
  }
  if (row.status !== 'completed') {
    throw conflict('a request with this idempotency key is still in progress');
  }
  if (row.response_status === null) {
    throw storeUnavailable();
  }

  return { status: row.response_status, body: row.response_body, replay: true };
}

/**
 * Runs `exec` at most once per `(userId, key)`.
 *
 * The reservation is an INSERT, so two concurrent requests race on the primary
 * key rather than on a read-then-write window. The loser inspects the stored
 * row: a completed attempt with the same body is replayed, a different body is
 * a conflict, and an attempt still in flight is a conflict the caller may
 * retry once it settles.
 *
 * Only 2xx and 4xx responses are stored. A 5xx is a server-side fault, so the
 * reservation is released and the key stays usable.
 */
export async function withIdempotency(
  userId: string,
  key: string,
  requestHash: string,
  exec: () => Promise<IdempotentResponse>,
): Promise<IdempotentOutcome> {
  const service = createServiceClient();

  const reserved = await service.from('idempotency_keys').insert({
    key,
    user_id: userId,
    request_hash: requestHash,
    status: 'in_progress',
  });

  if (reserved.error !== null) {
    if (reserved.error.code !== PG_UNIQUE_VIOLATION) throw storeUnavailable();
    return await replayExisting(service, userId, key, requestHash);
  }

  let response: IdempotentResponse;
  try {
    response = await exec();
  } catch (err) {
    await discard(service, userId, key);
    throw err;
  }

  if (response.status >= 500) {
    await discard(service, userId, key);
    return { ...response, replay: false };
  }

  const { error } = await service
    .from('idempotency_keys')
    .update({
      status: 'completed',
      response_status: response.status,
      response_body: response.body ?? null,
    })
    .eq('key', key)
    .eq('user_id', userId);

  if (error !== null) throw storeUnavailable();

  return { ...response, replay: false };
}
