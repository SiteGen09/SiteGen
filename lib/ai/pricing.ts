/** USD per million non-cached input tokens. */
export interface TokenRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedPerMTok: number;
}

/**
 * Raw provider cost in USD for one call.
 *
 * Rates are supplied by the caller rather than looked up from a model id, so
 * adding a model is a channel row rather than a code change and a redeploy.
 * `inputTokens` must exclude `cachedTokens`; cache reads are billed at the
 * cached rate. Every rate and count is validated: a bad figure would otherwise
 * silently undercharge a paid channel.
 */
export function costUsd(
  rates: TokenRates,
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number },
): number {
  for (const [name, rate] of [
    ['inputPerMTok', rates.inputPerMTok],
    ['outputPerMTok', rates.outputPerMTok],
    ['cachedPerMTok', rates.cachedPerMTok],
  ] as const) {
    if (!Number.isFinite(rate) || rate < 0) {
      throw new Error(`invalid ${name}: ${rate}`);
    }
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
    (inputTokens * rates.inputPerMTok +
      outputTokens * rates.outputPerMTok +
      cachedTokens * rates.cachedPerMTok) /
    1_000_000
  );
}

/** USD value of one credit. */
const USD_PER_CREDIT = 0.0001;

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