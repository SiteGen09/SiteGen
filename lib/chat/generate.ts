import { observePolicyRejection } from '@/lib/guardrails/runtime';
import { generateText } from 'ai';

import type { ChannelRow } from '@/lib/ai/fallback';
import { callWithFallback } from '@/lib/ai/fallback';
import type { ProviderCreds } from '@/lib/ai/provider';
import type { ReasoningEffort } from '@/lib/chat/reasoning';
import { buildAI } from '@/lib/ai/provider';
import { ApiError } from '@/lib/api/errors';
import type { TokenRates } from '@/lib/ai/pricing';
import type { ChatMessage, ChatTool, ChatToolChoice } from '@/lib/chat/request';
import type { OpenAiToolCall } from '@/lib/chat/tools';
import { toModelMessages, toOpenAiToolCalls, toToolChoice, toToolSet } from '@/lib/chat/tools';
import type { NormalizedUsage } from '@/lib/generate/usage';
import { normalizeUsage } from '@/lib/generate/usage';

export interface ChatGenerationResult {
  content: string;
  finishReason: string;
  /** Id of the channel that actually served the call. */
  channelId: string;
  /** Credit multiplier of the serving channel, as a number. */
  multiplier: number;
  /** The serving channel ran on the caller's own provider key. */
  byok: boolean;
  /** USD rates of the serving channel, for cost calculation. */
  rates: TokenRates;
  usage: NormalizedUsage;
  /**
   * Tool calls the model asked for, in OpenAI wire shape. Empty unless the
   * model chose to call a tool; the gateway never executes them.
   */
  toolCalls: OpenAiToolCall[];
  latencyMs: number;
}

export interface ChatGenerationParams {
  start: ChannelRow;
  resolve: (id: string) => Promise<ChannelRow | null>;
  buildCreds: (channel: ChannelRow) => Promise<ProviderCreds>;
  messages: ChatMessage[];
  maxOutputTokens: number;
  temperature?: number | undefined;
  topP?: number | undefined;
  stop?: string | string[] | undefined;
  tools?: readonly ChatTool[] | undefined;
  toolChoice?: ChatToolChoice | undefined;
  /** Omitted: the provider's own default effort. */
  reasoning?: ReasoningEffort | undefined;
}

/**
 * Refuses an upstream answer that gave the caller nothing usable, so the call
 * is treated as a provider failure and its hold released instead of settled.
 *
 * A provider can end a call "successfully" yet deliver nothing: an error or
 * content-filter finish, or an empty reply with no tool call. Billing only
 * ever follows a delivered answer, so these must fail rather than settle.
 */
export function assertDelivered(finishReason: string, text: string, toolCallCount: number): void {
  if (finishReason === 'error') {
    throw new ApiError('generation_failed', 'the provider failed to complete the response', 502);
  }
  if (finishReason === 'content-filter') {
    throw new ApiError('generation_failed', 'the provider withheld the response (content filter)', 502);
  }
  if (text.trim() === '' && toolCallCount === 0) {
    throw new ApiError('generation_failed', 'the provider returned an empty response', 502);
  }
}

/**
 * Runs a non-streaming chat completion, walking the channel fallback chain.
 *
 * Mirrors {@link generateSpec} but returns free-form text rather than a
 * schema-validated object, so there is no validation-retry loop: a single pass
 * per channel. Usage is normalized into the pricing buckets for settlement.
 */
export async function generateChat(params: ChatGenerationParams): Promise<ChatGenerationResult> {
  const startedAt = Date.now();
  let servingChannel: ChannelRow = params.start;

  const result = await callWithFallback(params.start, params.resolve, async (channel) => {
    servingChannel = channel;
    const creds = await params.buildCreds(channel);
    const ai = buildAI(creds);
    return await generateText({
      model: ai.languageModel(channel.modelId),
      maxRetries: 0,
      messages: toModelMessages(params.messages),
      // System turns arrive positionally in `messages` (a chat-completions
      // `system` role, or Responses `instructions`), so the SDK must accept
      // them there rather than only via its own `instructions` option.
      allowSystemInMessages: true,
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
      topP: params.topP,
      stopSequences:
        params.stop === undefined ? undefined : Array.isArray(params.stop) ? params.stop : [params.stop],
      tools: toToolSet(params.tools),
      toolChoice: toToolChoice(params.toolChoice),
      // On a native Anthropic channel the SDK turns any level into extended
      // thinking, which changes cost and turn-replay rules; leave those alone.
      reasoning: creds.provider === 'anthropic' || creds.provider === 'anthropic_compatible'
        ? undefined
        : params.reasoning,
    });
  });

  await observePolicyRejection({ finishReason: result.value.finishReason });
  assertDelivered(result.value.finishReason, result.value.text, result.value.toolCalls.length);
  const usage = normalizeUsage(result.value.usage, result.value.providerMetadata);

  return {
    content: result.value.text,
    finishReason: result.value.finishReason,
    toolCalls: toOpenAiToolCalls(result.value.toolCalls),
    channelId: servingChannel.id,
    multiplier: Number(servingChannel.creditMultiplier),
    byok: servingChannel.isByok,
    rates: servingChannel.rates,
    usage,
    latencyMs: Date.now() - startedAt,
  };
}
