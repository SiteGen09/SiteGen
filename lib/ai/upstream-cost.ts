import { KIE_USD_PER_CREDIT } from '@/lib/ai/kie-catalog';

/**
 * What an upstream says a call actually cost, where it says so. kie.ai puts
 * `credits_consumed` on every chat reply (the last chunk of a stream, the body
 * of a JSON reply, the `response.completed` event of a Responses stream). That
 * figure includes tokens its usage block leaves out, such as hidden reasoning,
 * so settlement prefers it to a token-count estimate (see billedCostUsd).
 *
 * One meter per built provider, and a provider is built per attempt, so the
 * figure belongs to exactly one channel attempt of one request.
 */
export interface CostMeter {
  /** Record the cost one upstream response reported. */
  addCredits(credits: number): void;
  /** Total USD reported so far, or undefined when nothing was reported. */
  usd(): number | undefined;
}

export function createKieCostMeter(): CostMeter {
  let credits: number | undefined;
  return {
    addCredits(value) {
      if (!Number.isFinite(value) || value < 0) return;
      credits = (credits ?? 0) + value;
    },
    usd: () => (credits === undefined ? undefined : Number((credits * KIE_USD_PER_CREDIT).toPrecision(12))),
  };
}

/** kie.ai's `credits_consumed` on a parsed reply or event, if present and sane. */
export function kieCreditsIn(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const credits = (value as Record<string, unknown>).credits_consumed;
  return typeof credits === 'number' && Number.isFinite(credits) && credits >= 0 ? credits : undefined;
}
