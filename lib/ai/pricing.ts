import { MODELS } from './models';

export interface ModelPricing {
  /** USD per million non-cached input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** USD per million cache-read input tokens. */
  cachedInputPerMTok: number;
}

/** USD list prices per model id. Keyed by {@link MODELS} so ids stay in one place. */
export const PRICING: Record<string, ModelPricing> = {
  [MODELS.strong]: { inputPerMTok: 15, outputPerMTok: 75, cachedInputPerMTok: 1.5 },
  [MODELS.cheap]: { inputPerMTok: 0.8, outputPerMTok: 4, cachedInputPerMTok: 0.08 },
  'stub-fixture': { inputPerMTok: 0.5, outputPerMTok: 2, cachedInputPerMTok: 0.05 },
  'gemini-3-8-flash': { inputPerMTok: 0.5, outputPerMTok: 1.5, cachedInputPerMTok: 0.05 },
};

/** USD value of one credit. */
const USD_PER_CREDIT = 0.0001;

/**
 * Raw provider cost in USD for one call.
 *
 * `inputTokens` must exclude `cachedTokens`; cache reads are billed at the
 * cached rate. Throws on an unpriced model rather than silently returning 0,
 * which would undercharge a paid channel.
 */
export function costUsd(
  modelId: string,
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number },
): number {
  const pricing = PRICING[modelId];
  if (pricing === undefined) {
    throw new Error(`no pricing configured for model '${modelId}'`);
  }

  const { inputTokens, outputTokens, cachedTokens } = usage;
  for (const [name, count] of [
    ['inputTokens', inputTokens],
    ['outputTokens', outputTokens],
    ['cachedTokens', cachedTokens],
  ] as const) {
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`invalid ${name}: ${count}`);
    }
  }

  return (
    (inputTokens * pricing.inputPerMTok +
      outputTokens * pricing.outputPerMTok +
      cachedTokens * pricing.cachedInputPerMTok) /
    1_000_000
  );
}

/**
 * Credits to charge for a call. One credit is $0.0001; the multiplier is the
 * channel's markup. A multiplier of 0 (BYOK) charges nothing. Partial credits
 * round up, so any billable usage costs at least one credit.
 */
export function creditsForUsage(costUsd: number, multiplier: number): number {
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error(`invalid costUsd: ${costUsd}`);
  }
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new Error(`invalid multiplier: ${multiplier}`);
  }
  if (multiplier === 0 || costUsd === 0) return 0;

  const raw = (costUsd / USD_PER_CREDIT) * multiplier;
  // Snap float noise (e.g. 3.0000000000000004) before rounding up so an exact
  // credit boundary is not billed an extra credit.
  return Math.ceil(Number(raw.toFixed(6)));
}
