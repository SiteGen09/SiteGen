import { z } from 'zod';

import { ApiError } from '@/lib/api/errors';
import { createServiceClient } from '@/lib/supabase/service';

/** A `bigint`-typed RPC (balances, credit counts) arrives as a number or string. */
const bigintResult = z.union([z.number(), z.string()]).transform(Number);

const rateLimitSchema = z.object({
  allowed: z.boolean(),
  retry_after_seconds: z.number().int().optional(),
  remaining: z.number().int().optional(),
});

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number | null;
}

const holdSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  balance: z.number().optional(),
  required: z.number().optional(),
  duplicate: z.boolean().optional(),
});

export interface HoldDecision {
  success: boolean;
  error: string | null;
  balance: number | null;
  required: number | null;
}

function rpcFailed(name: string): ApiError {
  return new ApiError('internal_error', `credit operation failed: ${name}`, 500);
}

export async function consumeRateLimit(
  apiKeyId: string,
  limit: number,
): Promise<RateLimitDecision> {
  const service = createServiceClient();
  const { data, error } = await service.rpc('consume_rate_limit', {
    p_api_key_id: apiKeyId,
    p_limit: limit,
  });
  if (error !== null) throw rpcFailed('consume_rate_limit');

  const parsed = rateLimitSchema.parse(data);
  return {
    allowed: parsed.allowed,
    retryAfterSeconds: parsed.retry_after_seconds ?? 60,
    remaining: parsed.remaining ?? null,
  };
}

export async function holdCredits(
  userId: string,
  requestId: string,
  estimatedCredits: number,
  channelId: string,
): Promise<HoldDecision> {
  const service = createServiceClient();
  const { data, error } = await service.rpc('hold_credits', {
    p_user_id: userId,
    p_request_id: requestId,
    p_estimated_credits: estimatedCredits,
    p_channel_id: channelId,
  });
  if (error !== null) throw rpcFailed('hold_credits');

  const parsed = holdSchema.parse(data);
  return {
    success: parsed.success,
    error: parsed.error ?? null,
    balance: parsed.balance ?? null,
    required: parsed.required ?? null,
  };
}

export async function settleCredits(
  requestId: string,
  actualCredits: number,
  meta: Record<string, unknown>,
): Promise<void> {
  const service = createServiceClient();
  const { error } = await service.rpc('settle_credits', {
    p_request_id: requestId,
    p_actual_credits: actualCredits,
    p_meta: meta,
  });
  if (error !== null) throw rpcFailed('settle_credits');
}

export async function releaseCredits(requestId: string): Promise<void> {
  const service = createServiceClient();
  const { error } = await service.rpc('release_credits', { p_request_id: requestId });
  if (error !== null) throw rpcFailed('release_credits');
}

export async function getBalance(userId: string): Promise<number> {
  const service = createServiceClient();
  const { data, error } = await service.rpc('get_balance', { p_user_id: userId });
  if (error !== null) throw rpcFailed('get_balance');
  return bigintResult.parse(data);
}

const reclaimResultSchema = z.object({
  count: z.number().int(),
  credits: bigintResult,
  holds: z.array(
    z.object({
      request_id: z.string(),
      user_id: z.string(),
      credits: bigintResult,
      held_since: z.string(),
    }),
  ),
});

export interface StrandedHold {
  requestId: string;
  userId: string;
  credits: number;
  heldSince: string;
}

export interface ReclaimResult {
  count: number;
  credits: number;
  holds: StrandedHold[];
}

/**
 * Releases credit holds abandoned by a process that died between the hold and
 * its settle/release. Without this the hold row and its debt are permanent.
 */
export async function reclaimStrandedHolds(
  olderThan: string,
): Promise<ReclaimResult> {
  const service = createServiceClient();
  const { data, error } = await service.rpc('reclaim_stranded_holds', {
    p_older_than: olderThan,
  });
  if (error !== null) throw rpcFailed('reclaim_stranded_holds');

  const parsed = reclaimResultSchema.parse(data);
  return {
    count: parsed.count,
    credits: parsed.credits,
    holds: parsed.holds.map((hold) => ({
      requestId: hold.request_id,
      userId: hold.user_id,
      credits: hold.credits,
      heldSince: hold.held_since,
    })),
  };
}
