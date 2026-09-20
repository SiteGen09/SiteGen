import type { OpenAiToolCall } from '@/lib/chat/tools';
import { openAiFinishReason } from '@/lib/chat/tools';
import type { OpenAiErrorBody } from '@/lib/api/openai-errors';
import type { NormalizedUsage } from '@/lib/generate/usage';

export interface ResponseObjectParams {
  requestId: string;
  model: string;
  createdAt: number;
  status: 'in_progress' | 'completed' | 'incomplete';
  content: string;
  toolCalls: readonly OpenAiToolCall[];
  finishReason: string | null;
  usage: NormalizedUsage | null;
}

export function responseObject(params: ResponseObjectParams): Record<string, unknown> {
  const { requestId, model, createdAt, status, content, toolCalls, finishReason, usage } = params;

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
      name: call.function.name,
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

export function createResponseFrames(params: {
  requestId: string;
  model: string;
  createdAt: number;
}): ResponseFrames {
  const { requestId, model, createdAt } = params;
  let sequenceNumber = 0;

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
      const data = {
        type: 'response.output_text.delta',
        sequence_number: sequenceNumber++,
        item_id: `msg_${requestId}`,
        output_index: 0,
        content_index: 0,
        delta: text,
      };
      return sseFrame('response.output_text.delta', data);
    },

    functionCallAdded(index: number, callId: string, name: string): string {
      const data = {
        type: 'response.output_item.added',
        sequence_number: sequenceNumber++,
        output_index: index + 1,
        item: {
          type: 'function_call',
          id: `fc_${callId}`,
          call_id: callId,
          name,
          arguments: '',
          status: 'in_progress',
        },
      };
      return sseFrame('response.output_item.added', data);
    },

    functionCallArgumentsDelta(index: number, callId: string, delta: string): string {
      const data = {
        type: 'response.function_call_arguments.delta',
        sequence_number: sequenceNumber++,
        item_id: `fc_${callId}`,
        output_index: index + 1,
        delta,
      };
      return sseFrame('response.function_call_arguments.delta', data);
    },

    functionCallDone(index: number, callId: string, name: string, args: string): string {
      const data = {
        type: 'response.output_item.done',
        sequence_number: sequenceNumber++,
        output_index: index + 1,
        item: {
          type: 'function_call',
          id: `fc_${callId}`,
          call_id: callId,
          name,
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
        }),
      };
      return sseFrame('response.completed', data);
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
