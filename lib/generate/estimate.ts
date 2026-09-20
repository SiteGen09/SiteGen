import type { ChannelRow } from '@/lib/ai/fallback';
import { costUsd, creditsForUsage } from '@/lib/ai/pricing';
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
 * An explicit BYOK channel holds nothing — the caller's own key pays. For a
 * billable channel the rates come from the channel row itself, so adding a
 * model needs no code change.
 */
export function estimateHoldCredits(channel: ChannelRow): number {
  const multiplier = Number(channel.creditMultiplier);
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new ApiError('channel_unavailable', 'channel has an invalid credit multiplier', 503);
  }
  if (channel.isByok) return 0;

  const cost = costUsd(channel.rates, HOLD_BUDGET_TOTAL);
  return creditsForUsage(cost, multiplier);
}

/** Deliberately coarse token estimate: ~4 characters per token. */
const CHARS_PER_TOKEN = 4;

/**
 * Credits to hold for a gateway chat call.
 *
 * Unlike {@link estimateHoldCredits}, the site-spec path owns its prompt and
 * can size from a fixed budget; here the caller supplies the messages and the
 * output ceiling, so the hold is derived from them. The input estimate is a
 * deliberate over-estimate — `ceil(totalChars / 4)` tends to exceed the real
 * token count — so a call can never settle above its hold; settle then
 * reconciles the true figure. No tokenizer dependency is taken for this.
 */
export function estimateChatHoldCredits(
  channel: ChannelRow,
  totalChars: number,
  maxOutputTokens: number,
): number {
  const multiplier = Number(channel.creditMultiplier);
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new ApiError('channel_unavailable', 'channel has an invalid credit multiplier', 503);
  }
  if (channel.isByok) return 0;

  const estimatedInput = Math.ceil(Math.max(0, totalChars) / CHARS_PER_TOKEN);
  const cost = costUsd(channel.rates, {
    inputTokens: estimatedInput,
    outputTokens: Math.max(0, maxOutputTokens),
    cachedTokens: 0,
  });
  return creditsForUsage(cost, multiplier);
}
