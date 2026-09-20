import { streamText, type TextStreamPart, type ToolSet } from 'ai';

import type { ChannelRow } from '@/lib/ai/fallback';
import { callWithFallback } from '@/lib/ai/fallback';
import type { ProviderCreds } from '@/lib/ai/provider';
import { buildAI } from '@/lib/ai/provider';
import type { ChatMessage, ChatTool, ChatToolChoice } from '@/lib/chat/request';
import { toModelMessages, toToolChoice, toToolSet } from '@/lib/chat/tools';
import type { NormalizedUsage } from '@/lib/generate/usage';
import { normalizeUsage } from '@/lib/generate/usage';

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
  maxOutputTokens: number;
  temperature?: number | undefined;
  topP?: number | undefined;
  stop?: string | string[] | undefined;
  tools?: readonly ChatTool[] | undefined;
  toolChoice?: ChatToolChoice | undefined;
}

/** Settlement figures, available only once the upstream stream has ended. */
export interface ChatStreamCompletion {
  finishReason: string;
  usage: NormalizedUsage;
  latencyMs: number;
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
  | { type: 'tool-call'; index: number; id: string; name: string; arguments: string };

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
): AsyncGenerator<ChatStreamPart> {
  const indexes = new Map<string, number>();

  for await (const part of source) {
    switch (part.type) {
      case 'text-delta':
        yield { type: 'text', text: part.text };
        break;

      case 'tool-input-start': {
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

  const attempt = await callWithFallback(params.start, params.resolve, async (channel) => {
    servingChannel = channel;
    const creds = await params.buildCreds(channel);
    const ai = buildAI(creds);

    const result = streamText({
      model: ai.languageModel(channel.modelId),
      messages: toModelMessages(params.messages),
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
      tools: toToolSet(params.tools),
      toolChoice: toToolChoice(params.toolChoice),
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
    return { result, iterator, primed };
  });

  const { result, iterator, primed } = attempt.value;

  const completion: Promise<ChatStreamCompletion> = (async () => {
    const [usage, finishReason, providerMetadata] = await Promise.all([
      result.usage,
      result.finishReason,
      result.providerMetadata,
    ]);
    return {
      finishReason,
      usage: normalizeUsage(usage, providerMetadata),
      latencyMs: Date.now() - startedAt,
    };
  })();

  return {
    channel: servingChannel,
    partStream: toChatParts(replay(primed, iterator)),
    completion,
  };
}
