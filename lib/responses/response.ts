import type { OpenAiToolCall } from '@/lib/chat/tools';
import { openAiFinishReason } from '@/lib/chat/tools';
import type { OpenAiErrorBody } from '@/lib/api/openai-errors';
import type { NormalizedUsage } from '@/lib/generate/usage';
import type { ToolName } from '@/lib/responses/request';

/** Upstream tool names back to the client's, for namespace members. */
type ResolveToolName = (upstreamName: string) => ToolName;

const plainToolName: ResolveToolName = (name) => ({ name });

/** A `function_call` item's name fields, with `namespace` only when there is one. */
function callName(resolve: ResolveToolName, upstreamName: string): { name: string; namespace?: string } {
  const { name, namespace } = resolve(upstreamName);
  return namespace === undefined ? { name } : { name, namespace };
}

export interface ResponseObjectParams {
  requestId: string;
  model: string;
  createdAt: number;
  status: 'in_progress' | 'completed' | 'incomplete';
  content: string;
  toolCalls: readonly OpenAiToolCall[];
  finishReason: string | null;
  usage: NormalizedUsage | null;
  resolveToolName?: ResolveToolName;
}

export function responseObject(params: ResponseObjectParams): Record<string, unknown> {
  const { requestId, model, createdAt, status, content, toolCalls, finishReason, usage } = params;
  const resolveToolName = params.resolveToolName ?? plainToolName;

  const output: Array<Record<string, unknown>> = [];

  // Message item only when content is non-empty
  if (content !== '') {
    output.push({
      type: 'message',
      id: `msg_${requestId}`,
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: content,
          annotations: [],
        },
      ],
    });
  }

  // One item per tool call
  for (const call of toolCalls) {
    output.push({
      type: 'function_call',
      id: `fc_${call.id}`,
      call_id: call.id,
      ...callName(resolveToolName, call.function.name),
      arguments: call.function.arguments,
      status: 'completed',
    });
  }

  const mappedFinishReason = finishReason !== null ? openAiFinishReason(finishReason) : null;
  const incompleteDetails =
    mappedFinishReason === 'length' ? { reason: 'max_output_tokens' } : null;

  return {
    id: `resp_${requestId}`,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    output: status === 'in_progress' ? [] : output,
    output_text: status === 'in_progress' ? '' : content,
    usage:
      usage === null
        ? null
        : {
            input_tokens: usage.inputTokens + usage.cachedTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.cachedTokens + usage.outputTokens,
            input_tokens_details: {
              cached_tokens: usage.cachedTokens,
            },
            output_tokens_details: {
              reasoning_tokens: 0,
            },
          },
    incomplete_details: status === 'in_progress' ? null : incompleteDetails,
    error: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
  };
}

/**
 * Responses API frames carry BOTH `event:` and `data:` lines. Chat completions
 * emits data-only frames — the Responses wire format requires the event prefix
 * for client routing.
 */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface ResponseFrames {
  created(): string;
  textDelta(text: string): string;
  functionCallAdded(index: number, callId: string, name: string): string;
  functionCallArgumentsDelta(index: number, callId: string, delta: string): string;
  functionCallDone(index: number, callId: string, name: string, args: string): string;
  completed(params: {
    content: string;
    toolCalls: readonly OpenAiToolCall[];
    finishReason: string;
    usage: NormalizedUsage;
  }): string;
  failed(body: OpenAiErrorBody): string;
}

/**
 * Frames for one streamed response, emitted in the order the Responses wire
 * format requires. Stateful, because the format is item-structured: text
 * deltas are only valid inside an announced message item, and `output_index`
 * is an item's position in the order items were announced, which is how
 * clients (Codex, the OpenAI SDK's stream accumulator) address them. A delta
 * for an item that was never added is dropped by those clients, so the message
 * item opens on the first text and closes before the next item or the end.
 */
export function createResponseFrames(params: {
  requestId: string;
  model: string;
  createdAt: number;
  resolveToolName?: ResolveToolName;
}): ResponseFrames {
  const { requestId, model, createdAt } = params;
  const resolveToolName = params.resolveToolName ?? plainToolName;
  const messageId = `msg_${requestId}`;
  let sequenceNumber = 0;
  let nextOutputIndex = 0;
  let message: { outputIndex: number; text: string; open: boolean } | null = null;
  const callIndexes = new Map<string, number>();

  function callOutputIndex(callId: string): number {
    let index = callIndexes.get(callId);
    if (index === undefined) {
      index = nextOutputIndex++;
      callIndexes.set(callId, index);
    }
    return index;
  }

  function openMessage(): string {
    message = { outputIndex: nextOutputIndex++, text: '', open: true };
    return (
      sseFrame('response.output_item.added', {
        type: 'response.output_item.added',
        sequence_number: sequenceNumber++,
        output_index: message.outputIndex,
        item: { type: 'message', id: messageId, status: 'in_progress', role: 'assistant', content: [] },
      }) +
      sseFrame('response.content_part.added', {
        type: 'response.content_part.added',
        sequence_number: sequenceNumber++,
        item_id: messageId,
        output_index: message.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      })
    );
  }

  /** Completes the message item if one is open. Safe to call when none is. */
  function closeMessage(): string {
    if (message === null || !message.open) return '';
    message.open = false;
    const part = { type: 'output_text', text: message.text, annotations: [] };
    return (
      sseFrame('response.output_text.done', {
        type: 'response.output_text.done',
        sequence_number: sequenceNumber++,
        item_id: messageId,
        output_index: message.outputIndex,
        content_index: 0,
        text: message.text,
      }) +
      sseFrame('response.content_part.done', {
        type: 'response.content_part.done',
        sequence_number: sequenceNumber++,
        item_id: messageId,
        output_index: message.outputIndex,
        content_index: 0,
        part,
      }) +
      sseFrame('response.output_item.done', {
        type: 'response.output_item.done',
        sequence_number: sequenceNumber++,
        output_index: message.outputIndex,
        item: { type: 'message', id: messageId, status: 'completed', role: 'assistant', content: [part] },
      })
    );
  }

  return {
    created(): string {
      const data = {
        type: 'response.created',
        sequence_number: sequenceNumber++,
        response: responseObject({
          requestId,
          model,
          createdAt,
          status: 'in_progress',
          content: '',
          toolCalls: [],
          finishReason: null,
          usage: null,
        }),
      };
      return sseFrame('response.created', data);
    },

    textDelta(text: string): string {
      // Text after the message closed (it follows a tool call) still streams
      // into the same item, as it always has; only the first text opens it.
      const prefix = message === null ? openMessage() : '';
      const target = message!;
      target.text += text;
      const data = {
        type: 'response.output_text.delta',
        sequence_number: sequenceNumber++,
        item_id: messageId,
        output_index: target.outputIndex,
        content_index: 0,
        delta: text,
      };
      return prefix + sseFrame('response.output_text.delta', data);
    },

    functionCallAdded(_index: number, callId: string, name: string): string {
      // The message item ends before the next item starts, as OpenAI streams it.
      const prefix = closeMessage();
      const data = {
        type: 'response.output_item.added',
        sequence_number: sequenceNumber++,
        output_index: callOutputIndex(callId),
        item: {
          type: 'function_call',
          id: `fc_${callId}`,
          call_id: callId,
          ...callName(resolveToolName, name),
          arguments: '',
          status: 'in_progress',
        },
      };
      return prefix + sseFrame('response.output_item.added', data);
    },

    functionCallArgumentsDelta(_index: number, callId: string, delta: string): string {
      const data = {
        type: 'response.function_call_arguments.delta',
        sequence_number: sequenceNumber++,
        item_id: `fc_${callId}`,
        output_index: callOutputIndex(callId),
        delta,
      };
      return sseFrame('response.function_call_arguments.delta', data);
    },

    functionCallDone(_index: number, callId: string, name: string, args: string): string {
      const data = {
        type: 'response.output_item.done',
        sequence_number: sequenceNumber++,
        output_index: callOutputIndex(callId),
        item: {
          type: 'function_call',
          id: `fc_${callId}`,
          call_id: callId,
          ...callName(resolveToolName, name),
          arguments: args,
          status: 'completed',
        },
      };
      return sseFrame('response.output_item.done', data);
    },

    completed(params: {
      content: string;
      toolCalls: readonly OpenAiToolCall[];
      finishReason: string;
      usage: NormalizedUsage;
    }): string {
      const { content, toolCalls, finishReason, usage } = params;
      const mappedFinishReason = openAiFinishReason(finishReason);
      const status = mappedFinishReason === 'length' ? 'incomplete' : 'completed';
      const prefix = closeMessage();

      const data = {
        type: 'response.completed',
        sequence_number: sequenceNumber++,
        response: responseObject({
          requestId,
          model,
          createdAt,
          status,
          content,
          toolCalls,
          finishReason,
          usage,
          resolveToolName,
        }),
      };
      return prefix + sseFrame('response.completed', data);
    },

    failed(body: OpenAiErrorBody): string {
      const data = {
        type: 'error',
        sequence_number: sequenceNumber++,
        ...body,
      };
      return sseFrame('error', data);
    },
  };
}
