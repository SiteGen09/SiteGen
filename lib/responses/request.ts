import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ChatMessage, ChatTool, ChatToolChoice } from '@/lib/chat/request';

/**
 * One function tool in the flat Responses API shape. Parameters is a schema
 * object, not a JSON-Schema wrapper — the wire format differs from chat.
 */
export const responsesToolSchema = z.looseObject({
  type: z.literal('function'),
  name: z.string().min(1, 'tool name is required'),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export type ResponsesTool = z.infer<typeof responsesToolSchema>;

export const responsesToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.looseObject({
    type: z.literal('function'),
    name: z.string().min(1, 'tool name is required'),
  }),
]);

export type ResponsesToolChoice = z.infer<typeof responsesToolChoiceSchema>;

/**
 * Content part inside a message item. The Responses API supports both
 * input_text/output_text (role-specific) and plain text parts.
 */
const contentPartSchema = z.looseObject({
  type: z.enum(['input_text', 'output_text', 'text']),
  text: z.string(),
});

/**
 * Input item discriminated union. Messages, function calls, and function call
 * outputs each have distinct shapes.
 */
const messageItemSchema = z.looseObject({
  type: z.literal('message').optional(),
  role: z.enum(['system', 'developer', 'user', 'assistant']),
  content: z.union([z.string(), z.array(contentPartSchema)]),
});

const functionCallItemSchema = z.looseObject({
  type: z.literal('function_call'),
  call_id: z.string().min(1, 'call_id is required'),
  id: z.string().optional(), // some clients send both
  name: z.string().min(1, 'function call name is required'),
  arguments: z.string(),
});

const functionCallOutputItemSchema = z.looseObject({
  type: z.literal('function_call_output'),
  call_id: z.string().min(1, 'call_id is required'),
  output: z.string(),
});

const inputItemSchema = z.union([
  messageItemSchema,
  functionCallItemSchema,
  functionCallOutputItemSchema,
]);

export type InputItem = z.infer<typeof inputItemSchema>;

/**
 * OpenAI Responses API request shape. This is a second wire format over the
 * same channels as chat completions — model selection and tool routing remain
 * identical, only the input representation differs.
 */
export const responsesRequestSchema = z.looseObject({
  model: z.string().min(1, 'model is required'),
  input: z.union([z.string(), z.array(inputItemSchema).min(1, 'at least one input item is required')]),
  instructions: z.string().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stream: z.boolean().optional(),
  tools: z.array(responsesToolSchema).optional(),
  tool_choice: responsesToolChoiceSchema.optional(),
});

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

/**
 * Translate Responses API input into chat messages. Instructions become a
 * leading system message; developer role maps to system; content part arrays
 * concatenate; consecutive function_call items merge into one assistant message
 * with multiple tool_calls.
 */
export function toChatMessages(request: ResponsesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // Instructions always become the first system message when present.
  if (request.instructions !== undefined && request.instructions.length > 0) {
    messages.push({ role: 'system', content: request.instructions });
  }

  // String input is a single user message.
  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input });
    return messages;
  }

  // Array input: process in order, merging consecutive function_call items.
  let pendingToolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

  const flushToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: pendingToolCalls,
      });
      pendingToolCalls = [];
    }
  };

  for (const item of request.input) {
    if (item.type === 'function_call') {
      pendingToolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments },
      });
      continue;
    }

    if (item.type === 'function_call_output') {
      flushToolCalls();
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
      continue;
    }

    flushToolCalls();
    messages.push({
      role: item.role === 'developer' ? 'system' : item.role,
      content:
        typeof item.content === 'string'
          ? item.content
          : item.content.map((part) => part.text).join(''),
    });
  }

  // Flush any remaining tool calls at the end.
  flushToolCalls();

  return messages;
}

/**
 * Lift flat Responses API tools to the nested chat completions shape.
 * Absent optional keys are omitted entirely.
 */
export function toChatTools(request: ResponsesRequest): ChatTool[] | undefined {
  if (request.tools === undefined) {
    return undefined;
  }

  return request.tools.map((tool) => {
    const fn: { name: string; description?: string; parameters?: Record<string, unknown> } = {
      name: tool.name,
    };

    if (tool.description !== undefined) {
      fn.description = tool.description;
    }

    if (tool.parameters !== undefined) {
      fn.parameters = tool.parameters;
    }

    return {
      type: 'function',
      function: fn,
    };
  });
}

/**
 * Translate Responses API tool_choice to the chat completions shape.
 * String forms pass through; object form nests the name under `function`.
 */
export function toChatToolChoice(request: ResponsesRequest): ChatToolChoice | undefined {
  if (request.tool_choice === undefined) {
    return undefined;
  }

  if (typeof request.tool_choice === 'string') {
    return request.tool_choice;
  }

  return {
    type: 'function',
    function: { name: request.tool_choice.name },
  };
}

/**
 * Stable hash binding an idempotency key to a body. Only the fields that shape
 * the generation are hashed, so a cosmetic field added by an SDK between
 * retries still replays rather than conflicts.
 */
export function responsesRequestHash(request: ResponsesRequest): string {
  const canonical = {
    model: request.model,
    input: request.input,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    temperature: request.temperature ?? null,
    top_p: request.top_p ?? null,
    tools: request.tools ?? null,
    tool_choice: request.tool_choice ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
