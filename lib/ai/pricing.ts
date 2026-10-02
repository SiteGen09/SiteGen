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

/**
 * A reported cost is refused above this multiple of the most the call's tokens
 * could cost, plus {@link REPORTED_COST_SLACK_USD} for per-request minimums.
 */
const REPORTED_COST_CEILING = 2;
const REPORTED_COST_SLACK_USD = 0.01;

/**
 * The upstream cost to settle a call at.
 *
 * Where the upstream reports what the call cost (kie.ai's `credits_consumed`),
 * that is the truth: it includes tokens a usage block can leave out, such as
 * hidden reasoning, and whatever cache price was actually applied. It is
 * trusted only while plausible, meaning no more than twice what every counted
 * token would cost at the channel's highest rate. Beyond that it is refused and
 * the token estimate stands, because a misreported figure would bill real money.
 */
export function billedCostUsd(
  rates: TokenRates,
  usage: Parameters<typeof costUsd>[1] & { totalTokens?: number; reportedCostUsd?: number },
): { costUsd: number; source: 'reported' | 'tokens' | 'reported_implausible' } {
  const estimate = costUsd(rates, usage);
  const reported = usage.reportedCostUsd;
  if (reported === undefined || !Number.isFinite(reported) || reported < 0) return { costUsd: estimate, source: 'tokens' };
  const tiers = rates.longContext ? [rates, rates.longContext] : [rates];
  const highest = Math.max(...tiers.flatMap((tier) => [tier.inputPerMTok, tier.outputPerMTok, tier.cachedPerMTok, tier.cacheWritePerMTok ?? 0]));
  const counted = usage.inputTokens + usage.outputTokens + usage.cachedTokens;
  const ceiling = (Math.max(counted, usage.totalTokens ?? 0) * highest / 1_000_000) * REPORTED_COST_CEILING + REPORTED_COST_SLACK_USD;
  return reported <= ceiling ? { costUsd: reported, source: 'reported' } : { costUsd: estimate, source: 'reported_implausible' };
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
