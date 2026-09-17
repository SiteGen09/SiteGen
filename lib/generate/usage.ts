import type { LanguageModelUsage } from 'ai';

/**
 * Token counts in the shape the pricing model expects: `inputTokens` excludes
 * cache reads, which are billed separately as `cachedTokens`.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Reads Anthropic's `cacheReadInputTokens` from provider metadata. The AI SDK
 * also exposes `inputTokenDetails.cacheReadTokens`, but the provider field is
 * the authoritative source called out by the generation contract; this is the
 * fallback when token details are absent.
 */
function cacheReadFromMetadata(providerMetadata: unknown): number {
  if (providerMetadata === null || typeof providerMetadata !== 'object') return 0;
  const anthropic = (providerMetadata as Record<string, unknown>).anthropic;
  if (anthropic === null || typeof anthropic !== 'object') return 0;
  const value = (anthropic as Record<string, unknown>).cacheReadInputTokens;
  return typeof value === 'number' ? finite(value) : 0;
}

/**
 * Splits a model call's usage into billable buckets. `usage.inputTokens` is the
 * total prompt size including cache reads, so the cached portion is subtracted
 * to avoid charging it at the full input rate twice.
 */
export function normalizeUsage(
  usage: LanguageModelUsage,
  providerMetadata: unknown,
): NormalizedUsage {
  const totalInput = finite(usage.inputTokens);
  const detailCached = finite(usage.inputTokenDetails?.cacheReadTokens);
  const cachedTokens = detailCached > 0 ? detailCached : cacheReadFromMetadata(providerMetadata);

  return {
    inputTokens: Math.max(0, totalInput - cachedTokens),
    outputTokens: finite(usage.outputTokens),
    cachedTokens,
  };
}
