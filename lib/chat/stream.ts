import { observePolicyRejection, trackGeneration } from '@/lib/guardrails/runtime';
import { streamText, type ModelMessage, type TextStreamPart, type ToolSet } from 'ai';

import type { ChannelRow } from '@/lib/ai/fallback';
import { callWithFallback } from '@/lib/ai/fallback';
import { recordAttemptFailure } from '@/lib/ai/attempt-failures';
import type { ProviderCreds } from '@/lib/ai/provider';
import type { ReasoningEffort } from '@/lib/chat/reasoning';
import { withInstructions } from '@/lib/gensite/identity';
import { buildAI } from '@/lib/ai/provider';
import { assertDelivered, serverToolLoop } from '@/lib/chat/generate';
import { segmentsText, turnSegments, type ServerToolKit } from '@/lib/chat/server-tools';
import type { ChatMessage, ChatTool, ChatToolChoice } from '@/lib/chat/request';
import { toModelMessages, toToolChoice } from '@/lib/chat/tools';
import type { NormalizedUsage } from '@/lib/generate/usage';
import { normalizeUsage, withReportedCost } from '@/lib/generate/usage';

/**
 * Streaming counterpart to {@link generateChat}.
 *
 * Coding harnesses (Cline, Roo, Kiro, opencode…) hold a streaming connection
 * open and render deltas as they arrive; a non-streaming endpoint is not
 * something they can fall back to, so this is the difference between the
 * gateway being usable by them and not.
 */

export interface ChatStreamParams {
  start: ChannelRow;
  resolve: (id: string) => Promise<ChannelRow | null>;
  buildCreds: (channel: ChannelRow) => Promise<ProviderCreds>;
  messages: ChatMessage[];
  /** Dashboard attachments, already validated and converted at the boundary. */
  modelMessages?: ModelMessage[];
  maxOutputTokens: number;
  temperature?: number | undefined;
  topP?: number | undefined;
  stop?: string | string[] | undefined;
  tools?: readonly ChatTool[] | undefined;
  toolChoice?: ChatToolChoice | undefined;
  /** Omitted: the provider's own default effort. */
  reasoning?: ReasoningEffort | undefined;
  /**
   * Stops the upstream request. The part stream then simply ends and
   * `completion` rejects with the abort reason, because the provider never
   * sends its usage report; the caller decides what the partial turn costs.
   */
  abortSignal?: AbortSignal | undefined;
  /** Tools the gateway runs itself inside the turn; see ServerToolKit. */
  serverTools?: ServerToolKit | undefined;
  /** A system instruction placed before everything the caller sent (gensite-v1's identity). */
  instructions?: string | undefined;
  /** A note placed after everything the caller sent (gensite-v1's stuck-loop warning). */
  reminder?: string | undefined;
}

/** Settlement figures, available only once the upstream stream has ended. */
export interface ChatStreamCompletion {
  finishReason: string;
  usage: NormalizedUsage;
  latencyMs: number;
  /**
   * Time to the first part only the upstream could have produced: the wait
   * before anything is shown, including any reasoning the provider does not
   * stream.
   */
  firstOutputMs: number;
}

/**
 * Log fields that tell a slow model from a slow start: the wait for the first
 * output, then the generation speed over the rest of the stream.
 */
export function streamTimingFields(done: ChatStreamCompletion): Record<string, number | null> {
  const generatingMs = done.latencyMs - done.firstOutputMs;
  return {
    first_output_ms: done.firstOutputMs,
    output_tokens: done.usage.outputTokens,
    output_tokens_per_s: generatingMs > 0
      ? Math.round((done.usage.outputTokens / generatingMs) * 10_000) / 10
      : null,
  };
}

/**
 * One fragment of an upstream response, flattened to what the OpenAI wire
 * format needs: text, or the pieces of a tool call.
 *
 * `index` is the tool call's position in the response, assigned by order of
 * first appearance so that a consumer re-assembling `tool_calls` deltas never
 * has to track ids itself.
 */
export type ChatStreamPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call-start'; index: number; id: string; name: string }
  | { type: 'tool-call-delta'; index: number; arguments: string }
  | { type: 'tool-call'; index: number; id: string; name: string; arguments: string }
  // A gateway tool the SDK is running, and what it returned. Wire formats
  // that cannot show these skip them; the caller never has to answer one.
  | { type: 'server-tool-call'; id: string; name: string; input: unknown }
  | { type: 'server-tool-result'; id: string; name: string; output: unknown };

export interface ChatStreamHandle {
  /** The channel that actually answered, after any fallback. */
  channel: ChannelRow;
  /** Ordered stream parts, beginning with the chunk used to prove the upstream works. */
  partStream: AsyncIterable<ChatStreamPart>;
  /**
   * Resolves when the upstream stream ends. Rejects if it fails mid-flight —
   * by then bytes are already on the wire, so the caller must decide what to
   * tell a client it can no longer send a status code to.
   */
  completion: Promise<ChatStreamCompletion>;
}

/**
 * Part types that do not prove the upstream answered.
 *
 * `start`, `start-step` and `stream-start` are generated locally before the
 * request is even in flight, and `raw` is passthrough noise, so priming has to
 * keep pulling past them to learn whether the channel is actually reachable.
 */
const LOCAL_LIFECYCLE_PARTS: Record<string, true> = {
  start: true,
  'start-step': true,
  'stream-start': true,
  raw: true,
};

/**
 * Flattens SDK stream parts into {@link ChatStreamPart}s.
 *
 * Split out from {@link streamChat} and kept free of any SDK call so the
 * fragment-reassembly rules can be exercised without a live model.
 */
export async function* toChatParts(
  source: AsyncIterable<TextStreamPart<ToolSet>>,
  /** Gateway tools: their calls surface as `server-tool-*` parts, never as the caller's. */
  serverToolNames: ReadonlySet<string> = new Set(),
): AsyncGenerator<ChatStreamPart> {
  const indexes = new Map<string, number>();
  let wroteText = false;
  // Text after a gateway tool run starts a new paragraph, as the buffered path joins steps.
  let afterServerTool = false;

  for await (const part of source) {
    switch (part.type) {
      case 'text-delta':
        if (part.text === '') break;
        yield { type: 'text', text: wroteText && afterServerTool ? `\n\n${part.text}` : part.text };
        wroteText = true;
        afterServerTool = false;
        break;

      case 'tool-result':
        if (serverToolNames.has(part.toolName)) {
          afterServerTool = true;
          yield { type: 'server-tool-result', id: part.toolCallId, name: part.toolName, output: part.output };
        }
        break;

      case 'tool-input-start': {
        if (serverToolNames.has(part.toolName)) break;
        const index = indexes.size;
        indexes.set(part.id, index);
        yield { type: 'tool-call-start', index, id: part.id, name: part.toolName };
        break;
      }

      case 'tool-input-delta': {
        const index = indexes.get(part.id);
        if (index === undefined) break;
        yield { type: 'tool-call-delta', index, arguments: part.delta };
        break;
      }

      case 'tool-call': {
        if (serverToolNames.has(part.toolName)) {
          yield { type: 'server-tool-call', id: part.toolCallId, name: part.toolName, input: part.input };
          break;
        }
        // Providers that streamed `tool-input-*` fragments have already
        // delivered this call; re-emitting it would duplicate the arguments.
        if (indexes.has(part.toolCallId)) break;
        const index = indexes.size;
        indexes.set(part.toolCallId, index);
        yield {
          type: 'tool-call',
          index,
          id: part.toolCallId,
          name: part.toolName,
          arguments: JSON.stringify(part.input ?? {}),
        };
        break;
      }

      // On `fullStream` a mid-stream upstream failure arrives as a part rather
      // than a rejection, and the caller's in-band error reporting needs it to
      // behave like one.
      case 'error':
        throw part.error;

      default:
        break;
    }
  }
}

/**
 * Re-emits a stream whose leading parts have already been pulled.
 *
 * Priming is what keeps the fallback chain meaningful while streaming: a dead
 * or throttled upstream fails on that first pull, before any byte has reached
 * the client, so the next channel can still be tried transparently. Once a
 * delta has been flushed, switching channels would corrupt the response, and
 * {@link callWithFallback} is deliberately out of the picture.
 */
async function* replay(
  primed: readonly TextStreamPart<ToolSet>[],
  iterator: AsyncIterator<TextStreamPart<ToolSet>>,
): AsyncGenerator<TextStreamPart<ToolSet>> {
  for (const part of primed) yield part;

  while (true) {
    const next = await iterator.next();
    if (next.done === true) return;
    yield next.value;
  }
}

export async function streamChat(params: ChatStreamParams): Promise<ChatStreamHandle> {
  const startedAt = Date.now();
  let servingChannel: ChannelRow = params.start;
  const kit = params.serverTools;
  const loop = serverToolLoop(params.tools, params.toolChoice, kit);

  const attempt = await callWithFallback(params.start, params.resolve, async (channel) => {
    servingChannel = channel;
    const creds = await params.buildCreds(channel);
    const ai = buildAI(creds);
    const state: { failure?: { error: unknown } } = {};

    const result = streamText({
      model: ai.languageModel(channel.modelId),
      maxRetries: 0,
      messages: withInstructions(params.modelMessages ?? toModelMessages(params.messages), params.instructions, params.reminder),
      // See generateChat: system turns are carried positionally in `messages`.
      allowSystemInMessages: true,
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
      topP: params.topP,
      stopSequences:
        params.stop === undefined
          ? undefined
          : Array.isArray(params.stop)
            ? params.stop
            : [params.stop],
      tools: loop.tools,
      toolChoice: toToolChoice(params.toolChoice),
      stopWhen: loop.stopWhen,
      prepareStep: loop.prepareStep,
      // On a native Anthropic channel the SDK turns any level into extended
      // thinking, which changes cost and turn-replay rules; leave those alone.
      reasoning: creds.provider === 'anthropic' || creds.provider === 'anthropic_compatible'
        ? undefined
        : params.reasoning,
      abortSignal: params.abortSignal,
      onError({ error }) {
        state.failure ??= { error };
      },
    });

    // `streamText` returns before the request is made, so an unreachable
    // upstream or a rejected key only surfaces here. `fullStream` opens with
    // locally generated lifecycle parts, so priming has to pull until a part
    // that only the upstream could have produced, which turns a dead channel
    // into a plain thrown error for the fallback walk to classify.
    const iterator = result.fullStream[Symbol.asyncIterator]();
    const primed: TextStreamPart<ToolSet>[] = [];
    while (true) {
      const next = await iterator.next();
      if (next.done === true) break;
      if (next.value.type === 'error') throw next.value.error;
      primed.push(next.value);
      if (LOCAL_LIFECYCLE_PARTS[next.value.type] !== true) break;
    }
    return { result, iterator, primed, state, ai, firstOutputMs: Date.now() - startedAt };
  }, recordAttemptFailure, params.abortSignal);

  const { result, iterator, primed, state, ai, firstOutputMs } = attempt.value;

  const completion: Promise<ChatStreamCompletion> = (async () => {
    const [usage, finishReason, providerMetadata, finalText, allToolCalls, steps] = await Promise.all([
      result.usage,
      result.finishReason,
      result.providerMetadata,
      result.text,
      result.toolCalls,
      result.steps,
    ]);
    const toolCalls = kit ? allToolCalls.filter((call) => !kit.names.has(call.toolName)) : allToolCalls;
    const text = kit ? segmentsText(turnSegments(steps, kit.names)) : finalText;
    // The SDK can resolve usage even after emitting an error part. Billing
    // awaits this promise independently of partStream, so both must fail.
    if (state.failure) {
      await observePolicyRejection(state.failure.error);
      throw state.failure.error;
    }
    await observePolicyRejection({ finishReason });
    // Settlement follows only a delivered answer; an empty or withheld one is
    // a provider failure and releases the hold.
    assertDelivered(finishReason, text, toolCalls.length);
    return {
      finishReason,
      usage: withReportedCost(normalizeUsage(usage, providerMetadata), ai.reportedCostUsd?.()),
      latencyMs: Date.now() - startedAt,
      firstOutputMs,
    };
  })();

  trackGeneration(completion);
  return {
    channel: servingChannel,
    partStream: toChatParts(replay(primed, iterator), kit?.names),
    completion,
  };
}
