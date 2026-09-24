/** USD per million non-cached input tokens. */
export interface TokenRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cachedPerMTok: number;
  cacheWritePerMTok?: number;
  longContext?: { threshold: number; inputPerMTok: number; outputPerMTok: number; cachedPerMTok: number; cacheWritePerMTok?: number };
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
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens?: number },
): number {
  // Cache writes remain part of inputTokens for legacy channels. Only channels
  // explicitly publishing a write rate split them into a fourth billing bucket.
  const totalInput = usage.inputTokens + usage.cachedTokens;
  if (rates.longContext && totalInput > rates.longContext.threshold) rates = rates.longContext;
  for (const [name, rate] of [
    ['inputPerMTok', rates.inputPerMTok],
    ['outputPerMTok', rates.outputPerMTok],
    ['cachedPerMTok', rates.cachedPerMTok],
    ['cacheWritePerMTok', rates.cacheWritePerMTok ?? rates.inputPerMTok],
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
    ['cacheWriteTokens', usage.cacheWriteTokens ?? 0],
  ] as const) {
    if (!Number.isFinite(count) || count < 0) {
      throw new Error(`invalid ${name}: ${count}`);
    }
  }

  const writes = rates.cacheWritePerMTok === undefined ? 0 : usage.cacheWriteTokens ?? 0;
  if (writes > inputTokens) throw new Error('cache write tokens exceed non-cached input');
  return (
    ((inputTokens - writes) * rates.inputPerMTok +
      writes * (rates.cacheWritePerMTok ?? rates.inputPerMTok) +
      outputTokens * rates.outputPerMTok +
      cachedTokens * rates.cachedPerMTok) /
    1_000_000
  );
}

/** USD value of one credit. Admin revenue reporting values consumed credits at this rate. */
export const USD_PER_CREDIT = 0.0001;

/**
 * What one upstream credit costs in USD at kie.ai. Published on their pricing
 * page and corroborated by every job we have run: an image reporting
 * `creditsConsumed: 6` matches their advertised $0.03 per image.
 *
 * This is what lets settlement charge the real cost. A media channel's
 * `request_price_usd` is only an estimate for the hold — it has to be, because
 * a video's price depends on duration and resolution, which are inputs rather
 * than properties of the model. Settlement keeps the reported count in the
 * settle row's `meta.upstream_credits`, which is how admin reporting recovers
 * the provider cost of a media job.
 */
export const MEDIA_UPSTREAM_USD_PER_CREDIT = 0.005;

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
