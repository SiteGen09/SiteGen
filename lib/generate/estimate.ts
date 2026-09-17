import type { ChannelRow } from '@/lib/ai/fallback';
import { PRICING, costUsd, creditsForUsage } from '@/lib/ai/pricing';
import { ApiError } from '@/lib/api/errors';
import { MAX_ROUNDS } from '@/lib/generate/generate';

/**
 * Worst-case token budget for a single generation round. Deliberately
 * generous: the hold must cover the largest plausible generation so a call can
 * never overspend a balance. The exact amount is reconciled at settle time.
 */
export const HOLD_BUDGET = { inputTokens: 10_000, outputTokens: 8_000, cachedTokens: 0 } as const;

/**
 * The budget the hold must actually cover: usage is summed across every round
 * {@link generateSpec} can attempt, including the ones that fail schema
 * validation, so sizing for a single round would let a retry settle for twice
 * its hold and drive the balance negative.
 */
export const HOLD_BUDGET_TOTAL = {
  inputTokens: HOLD_BUDGET.inputTokens * MAX_ROUNDS,
  outputTokens: HOLD_BUDGET.outputTokens * MAX_ROUNDS,
  cachedTokens: HOLD_BUDGET.cachedTokens * MAX_ROUNDS,
} as const;

/**
 * Credits to reserve before running `channel`.
 *
 * A zero multiplier (BYOK) holds nothing — the caller's own key pays. For a
 * billable channel the model must be priced; an unpriced billable channel is a
 * misconfiguration that would silently undercharge, so it is rejected as
 * unavailable rather than run.
 */
export function estimateHoldCredits(channel: ChannelRow): number {
  const multiplier = Number(channel.creditMultiplier);
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new ApiError('channel_unavailable', 'channel has an invalid credit multiplier', 503);
  }
  if (multiplier === 0) return 0;

  if (PRICING[channel.modelId] === undefined) {
    throw new ApiError('channel_unavailable', 'channel model is not priced', 503);
  }

  const cost = costUsd(channel.modelId, HOLD_BUDGET_TOTAL);
  return creditsForUsage(cost, multiplier);
}
