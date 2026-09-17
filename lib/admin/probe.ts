import { generateText } from 'ai';

import { costUsd } from '@/lib/ai/pricing';
import { buildAI, type ProviderCreds } from '@/lib/ai/provider';

/**
 * Minimal live model call used to verify credentials.
 *
 * Shared by the channel test endpoint and the platform-credential add/rotate
 * actions so "does this key actually work" has one definition. Server-only.
 */

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  /** null when the model has no configured price, so cost cannot be derived. */
  costUsd: number | null;
  error?: string;
}

/** Upper bound on a probe; keeps a wedged provider from hanging the admin UI. */
const PROBE_TIMEOUT_MS = 20_000;

/** Enough tokens for a one-word reply — the point is the round trip, not the text. */
const PROBE_MAX_OUTPUT_TOKENS = 8;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}

export async function probeCredentials(
  creds: ProviderCreds,
  modelId: string,
): Promise<ProbeResult> {
  const startedAt = Date.now();

  try {
    const ai = buildAI(creds);
    const result = await generateText({
      model: ai.languageModel(modelId),
      prompt: 'Reply with the single word: ok',
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;

    const { usage } = result;
    const cachedTokens = usage.inputTokenDetails.cacheReadTokens ?? 0;
    const inputTokens =
      usage.inputTokenDetails.noCacheTokens ??
      Math.max((usage.inputTokens ?? 0) - cachedTokens, 0);
    const outputTokens = usage.outputTokens ?? 0;

    let cost: number | null = null;
    try {
      cost = costUsd(modelId, { inputTokens, outputTokens, cachedTokens });
    } catch {
      // Unpriced model: the probe still proves the credential works.
      cost = null;
    }

    return { ok: true, latencyMs, costUsd: cost };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      costUsd: null,
      error: errorMessage(err),
    };
  }
}
