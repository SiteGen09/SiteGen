import { isPolicyRejection } from '@/lib/guardrails/policy';
import { observePolicyRejection } from '@/lib/guardrails/runtime';
import { NoObjectGeneratedError, generateObject } from 'ai';

import type { TokenRates } from '@/lib/ai/pricing';

import type { ChannelRow } from '@/lib/ai/fallback';
import { callWithFallback } from '@/lib/ai/fallback';
import type { ProviderCreds } from '@/lib/ai/provider';
import { buildAI } from '@/lib/ai/provider';
import { ApiError } from '@/lib/api/errors';
import { SPEC_SYSTEM_PROMPT, withValidationFeedback } from '@/lib/generate/prompt';
import type { NormalizedUsage } from '@/lib/generate/usage';
import { normalizeUsage } from '@/lib/generate/usage';
import type { SiteSpec } from '@/lib/spec/schema';
import { siteSpecSchema } from '@/lib/spec/schema';

/**
 * Total tries: the first attempt plus one validation-feedback retry.
 *
 * Exported because the pre-flight hold must cover every round that can bill,
 * not just the last one — usage from a failed attempt is still settled.
 */
export const MAX_ROUNDS = 2;
const MAX_VALIDATION_MESSAGE_CHARS = 800;

export interface SpecGenerationResult {
  spec: SiteSpec;
  /** Id of the channel that actually served the successful call. */
  channelId: string;
  /** Credit multiplier of the serving channel, as a number. */
  multiplier: number;
  /** Model id of the serving channel, for cost calculation. */
  modelId: string;
  /** USD rates of the serving channel, for cost calculation. */
  rates: TokenRates;
  /** Token usage summed across every attempt, including failed ones. */
  usage: NormalizedUsage;
  latencyMs: number;
}

export interface GenerateSpecParams {
  start: ChannelRow;
  resolve: (id: string) => Promise<ChannelRow | null>;
  buildCreds: (channel: ChannelRow) => Promise<ProviderCreds>;
  prompt: string;
  maxOutputTokens: number;
}

function addUsage(into: NormalizedUsage, more: NormalizedUsage): void {
  into.inputTokens += more.inputTokens;
  into.outputTokens += more.outputTokens;
  into.cachedTokens += more.cachedTokens;
}

/** Pulls a concise validation reason out of a `NoObjectGeneratedError`. */
function validationMessage(err: NoObjectGeneratedError): string {
  const cause = err.cause;
  const raw = cause instanceof Error ? cause.message : err.message;
  return raw.slice(0, MAX_VALIDATION_MESSAGE_CHARS);
}

/**
 * Generates a site spec, walking the channel fallback chain per attempt and
 * retrying once with the schema-validation error fed back into the prompt.
 *
 * Token usage from a failed attempt is still counted so the caller settles the
 * real cost. A second validation failure is terminal: the model could not
 * produce a conforming spec, surfaced as `generation_failed`.
 */
export async function generateSpec(params: GenerateSpecParams): Promise<SpecGenerationResult> {
  const usage: NormalizedUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const startedAt = Date.now();
  let prompt = params.prompt;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let servingChannel: ChannelRow = params.start;
    try {
      const result = await callWithFallback(params.start, params.resolve, async (channel) => {
        servingChannel = channel;
        const creds = await params.buildCreds(channel);
        const ai = buildAI(creds);
        return await generateObject({
          model: ai.languageModel(channel.modelId),
          maxRetries: 0,
          schema: siteSpecSchema,
          system: SPEC_SYSTEM_PROMPT,
          prompt,
          maxOutputTokens: params.maxOutputTokens,
        });
      });

      addUsage(usage, normalizeUsage(result.value.usage, result.value.providerMetadata));
      return {
        spec: result.value.object,
        channelId: servingChannel.id,
        multiplier: Number(servingChannel.creditMultiplier),
        modelId: servingChannel.modelId,
        rates: servingChannel.rates,
        usage,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      await observePolicyRejection(err);
      if (isPolicyRejection(err)) throw err;
      if (!NoObjectGeneratedError.isInstance(err)) throw err;
      if (err.usage !== undefined) addUsage(usage, normalizeUsage(err.usage, undefined));
      if (round === MAX_ROUNDS - 1) break;
      prompt = withValidationFeedback(params.prompt, validationMessage(err));
    }
  }

  throw new ApiError('generation_failed', 'model could not produce a valid site spec', 502);
}
