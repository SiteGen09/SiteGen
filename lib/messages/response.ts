import type { OpenAiToolCall } from '@/lib/chat/tools';
import { openAiFinishReason } from '@/lib/chat/tools';
import type { OpenAiErrorBody } from '@/lib/api/openai-errors';
import type { NormalizedUsage } from '@/lib/generate/usage';

/**
 * Anthropic Messages responses, buffered and streamed.
 *
 * The buffered shape is a single `message` object whose `content` is an array
 * of blocks. The streamed shape is a state machine over those blocks —
 * `message_start`, then a `content_block_start`/`delta`/`stop` group per
 * block, then `message_delta` carrying the stop reason and output tokens, then
 * `message_stop`. Anthropic SDKs assemble the final message from those frames,
 * so the indices have to be contiguous and every opened block has to close.
 */

/** Chat completions finish reasons mapped to Anthropic's vocabulary. */
export function anthropicStopReason(finishReason: string | null): string | null {
  if (finishReason === null) return null;
  switch (openAiFinishReason(finishReason)) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

/**
 * Anthropic reports only uncached input in `input_tokens` and breaks cache
 * reads out separately, where chat completions folds them together.
 */
function usageBody(usage: NormalizedUsage): Record<string, number> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cachedTokens,
    cache_creation_input_tokens: 0,
  };
}

function contentBlocks(
  content: string,
  toolCalls: readonly OpenAiToolCall[],
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  if (content !== '') blocks.push({ type: 'text', text: content });

  for (const call of toolCalls) {
    let input: unknown = {};
    try {
      input = call.function.arguments === '' ? {} : JSON.parse(call.function.arguments);
    } catch {
      // Upstream emitted arguments that are not valid JSON. Anthropic's schema
      // requires an object, so surface the raw text rather than dropping the
      // call or failing the whole response over it.
      input = { _raw: call.function.arguments };
    }
    blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }

  return blocks;
}

export interface MessageObjectParams {
  requestId: string;
  model: string;
  content: string;
  toolCalls: readonly OpenAiToolCall[];
  finishReason: string | null;
  usage: NormalizedUsage | null;
}

export function messageObject(params: MessageObjectParams): Record<string, unknown> {
  const { requestId, model, content, toolCalls, finishReason, usage } = params;
  return {
    id: `msg_${requestId}`,
    type: 'message',
    role: 'assistant',
    model,
    content: contentBlocks(content, toolCalls),
    stop_reason: anthropicStopReason(finishReason),
    stop_sequence: null,
    usage: usage === null ? null : usageBody(usage),
  };
}

/** Every Anthropic stream frame carries both an `event:` and a `data:` line. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface MessageFrames {
  start(): string;
  /** Opens the text block lazily, so a tool-only reply emits no empty text. */
  textDelta(text: string): string;
  toolCallStart(callId: string, name: string): string;
  toolCallArgumentsDelta(delta: string): string;
  /** Closes whichever block is open. Safe to call when none is. */
  closeBlock(): string;
  delta(params: { finishReason: string; usage: NormalizedUsage }): string;
  stop(): string;
  error(body: OpenAiErrorBody): string;
}

export function createMessageFrames(params: {
  requestId: string;
  model: string;
}): MessageFrames {
  const { requestId, model } = params;
  // Anthropic numbers content blocks contiguously from zero across the whole
  // message, text and tool_use alike, so one counter serves both.
  let index = -1;
  let open = false;

  function openBlock(block: Record<string, unknown>): string {
    index += 1;
    open = true;
    return sseFrame('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: block,
    });
  }

  return {
    start(): string {
      return sseFrame('message_start', {
        type: 'message_start',
        message: {
          id: `msg_${requestId}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          // Anthropic sends a usage stub up front and the real output count in
          // `message_delta`; clients read both, so neither may be omitted.
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    },

    textDelta(text: string): string {
      const prefix = open ? '' : openBlock({ type: 'text', text: '' });
      return (
        prefix +
        sseFrame('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text },
        })
      );
    },

    toolCallStart(callId: string, name: string): string {
      // A tool call always begins its own block, so anything open closes first.
      const prefix = open ? this.closeBlock() : '';
      return prefix + openBlock({ type: 'tool_use', id: callId, name, input: {} });
    },

    toolCallArgumentsDelta(delta: string): string {
      return sseFrame('content_block_delta', {
        type: 'content_block_delta',
        index,
        // Anthropic streams tool arguments as partial JSON text, which the SDK
        // accumulates and parses once the block stops.
        delta: { type: 'input_json_delta', partial_json: delta },
      });
    },

    closeBlock(): string {
      if (!open) return '';
      open = false;
      return sseFrame('content_block_stop', { type: 'content_block_stop', index });
    },

    delta(deltaParams: { finishReason: string; usage: NormalizedUsage }): string {
      return sseFrame('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: anthropicStopReason(deltaParams.finishReason),
          stop_sequence: null,
        },
        usage: usageBody(deltaParams.usage),
      });
    },

    stop(): string {
      return sseFrame('message_stop', { type: 'message_stop' });
    },

    error(body: OpenAiErrorBody): string {
      // Anthropic's error envelope names the type differently from OpenAI's,
      // but the message is the part a client surfaces, so it is carried across.
      return sseFrame('error', {
        type: 'error',
        error: { type: 'api_error', message: body.error.message },
      });
    },
  };
}
