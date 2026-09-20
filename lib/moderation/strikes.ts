import { z } from 'zod';

import type { Logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Abuse strikes and the auto-suspend they drive.
 *
 * A moderation-flagged request writes one strike; when a user's strike count
 * within a rolling 24 hours reaches the threshold, the account is suspended.
 * Enforcement of the suspension lives in `authenticateApiKey`, so setting the
 * status here is all that is needed to stop the next call.
 */

const DEFAULT_STRIKE_THRESHOLD = 5;

/** `bigint` count arrives from the RPC as a number or string. */
const countSchema = z.union([z.number(), z.string()]).transform(Number);

function strikeThreshold(): number {
  const raw = process.env.ABUSE_STRIKE_THRESHOLD;
  if (raw === undefined || raw.length === 0) return DEFAULT_STRIKE_THRESHOLD;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_STRIKE_THRESHOLD;
}

/**
 * Records one strike for a flagged request and, if the rolling-window count has
 * reached the threshold, suspends the user. Returns whether a suspension was
 * applied. A failure here must not mask the request's own outcome, so callers
 * treat a throw as non-fatal.
 */
export async function recordStrikeAndMaybeSuspend(
  userId: string,
  requestId: string,
  categories: string[],
  log: Logger,
): Promise<{ strikeCount: number; suspended: boolean }> {
  const service = createServiceClient();

  const { data, error } = await service.rpc('record_abuse_strike', {
    p_user_id: userId,
    p_request_id: requestId,
    p_categories: categories,
  });
  if (error !== null) {
    throw new Error(`record_abuse_strike failed: ${error.message}`);
  }

  const strikeCount = countSchema.parse(data);
  const threshold = strikeThreshold();
  if (strikeCount < threshold) {
    return { strikeCount, suspended: false };
  }

  // Only suspend an account that is still active, so a repeat offender already
  // suspended does not re-trigger the alert on every subsequent strike.
  const { data: updated, error: suspendError } = await service
    .from('profiles')
    .update({ status: 'suspended' })
    .eq('id', userId)
    .eq('status', 'active')
    .select('id');
  if (suspendError !== null) {
    throw new Error(`auto-suspend failed: ${suspendError.message}`);
  }

  const suspended = Array.isArray(updated) && updated.length > 0;
  if (suspended) {
    log.error('abuse.auto_suspended', {
      alert: true,
      user_id: userId,
      strike_count: strikeCount,
      threshold,
    });
  }
  return { strikeCount, suspended };
}
