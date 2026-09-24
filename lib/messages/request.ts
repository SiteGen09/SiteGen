import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ChatMessage, ChatTool, ChatToolCall, ChatToolChoice } from '@/lib/chat/request';

/**
 * Anthropic Messages API request shape — a third wire format over the same
 * channels as chat completions and responses.
 *
 * This is the protocol Claude Code, Claude Desktop and every Anthropic SDK
 * speak, so accepting it inbound is what lets those clients point at this
 * gateway. It is deliberately independent of the `anthropic` *provider*, which
 * describes what we speak upstream: a request arriving here in Anthropic shape
 * may well be served by an OpenAI-compatible channel, and vice versa.
 *
 * Loose objects throughout, for the same reason as chat completions: real
 * SDKs attach fields we do not model (`metadata`, `service_tier`, cache
 * controls) and rejecting them would break working clients.
 */

const textBlockSchema = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
});

/** An assistant turn's tool invocation, replayed to us on the next request. */
const toolUseBlockSchema = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string().min(1, 'tool_use id is required'),
  name: z.string().min(1, 'tool_use name is required'),
  input: z.unknown(),
});

/**
 * The caller's answer to a `tool_use`. Anthropic allows the result to be a
 * bare string or a block array; chat completions has only a string, so both
 * are flattened to text on the way through.
 */
const toolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1, 'tool_use_id is required'),
  content: z.union([z.string(), z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))]).optional(),
  is_error: z.boolean().optional(),
});

const contentBlockSchema = z.union([textBlockSchema, toolUseBlockSchema, toolResultBlockSchema]);

export type ContentBlock = z.infer<typeof contentBlockSchema>;

const messageSchema = z.looseObject({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
});

export const messagesToolSchema = z.looseObject({
  name: z.string().min(1, 'tool name is required'),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()).optional(),
});

/**
 * `any` and `auto` both mean "model decides whether to call something", with
 * `any` forcing at least one call — chat completions spells those `auto` and
 * `required`.
 */
export const messagesToolChoiceSchema = z.looseObject({
  type: z.enum(['auto', 'any', 'tool', 'none']),
  name: z.string().optional(),
});

export const messagesRequestSchema = z.looseObject({
  model: z.string().min(1, 'model is required'),
  messages: z.array(messageSchema).min(1, 'at least one message is required'),
  /** Required by Anthropic, unlike the OpenAI formats where it is optional. */
  max_tokens: z.number().int().positive('max_tokens must be a positive integer'),
  system: z.union([z.string(), z.array(textBlockSchema)]).optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  tools: z.array(messagesToolSchema).optional(),
  tool_choice: messagesToolChoiceSchema.optional(),
});

export type MessagesRequest = z.infer<typeof messagesRequestSchema>;

/** Anthropic's block arrays collapse to the single string chat completions has. */
function blockText(content: string | ReadonlyArray<{ text?: string | undefined }>): string {
  return typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('');
}

/**
 * Translate an Anthropic Messages request into chat messages.
 *
 * Three shape differences have to be reconciled. `system` is a top-level field
 * rather than a message, so it becomes a leading system message. Tool results
 * ride inside a *user* turn in Anthropic's format but are their own `tool`
 * role in chat completions, so they are lifted out. And an assistant turn
 * mixing prose with tool calls carries both in one content array, which maps
 * to a single assistant message with `content` and `tool_calls` side by side.
 */
export function toChatMessages(request: MessagesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (request.system !== undefined) {
    const system = blockText(request.system);
    if (system.length > 0) messages.push({ role: 'system', content: system });
  }

  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    // Tool results are emitted before the turn that carried them: they answer
    // the *previous* assistant turn, and chat completions orders them that way.
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: block.content === undefined ? '' : blockText(block.content),
        });
      }
    }

    const text = message.content
      .filter((block): block is z.infer<typeof textBlockSchema> => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const toolCalls: ChatToolCall[] = message.content
      .filter((block): block is z.infer<typeof toolUseBlockSchema> => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function',
        // Anthropic sends parsed JSON; chat completions wants it stringified.
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      }));

    if (toolCalls.length > 0) {
      // Only an assistant turn can carry tool calls. Text alongside them is
      // kept rather than dropped: it is the model's reasoning for the call.
      messages.push({
        role: 'assistant',
        content: text.length > 0 ? text : null,
        tool_calls: toolCalls,
      });
      continue;
    }

    // A user turn that was nothing but tool results has already been emitted.
    if (text.length === 0 && message.content.some((block) => block.type === 'tool_result')) {
      continue;
    }

    messages.push({ role: message.role, content: text });
  }

  return messages;
}

/** Anthropic's flat tool shape lifted into the nested chat completions one. */
export function toChatTools(request: MessagesRequest): ChatTool[] | undefined {
  if (request.tools === undefined) return undefined;

  return request.tools.map((tool) => {
    const fn: { name: string; description?: string; parameters?: Record<string, unknown> } = {
      name: tool.name,
    };
    if (tool.description !== undefined) fn.description = tool.description;
    if (tool.input_schema !== undefined) fn.parameters = tool.input_schema;
    return { type: 'function', function: fn };
  });
}

/**
 * `any` means "call some tool", which chat completions spells `required`.
 * `tool` names one, and needs the name Anthropic puts beside the type.
 */
export function toChatToolChoice(request: MessagesRequest): ChatToolChoice | undefined {
  const choice = request.tool_choice;
  if (choice === undefined) return undefined;

  switch (choice.type) {
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      // A `tool` choice without a name is meaningless; fall back to letting
      // the model decide rather than sending a malformed choice upstream.
      return choice.name === undefined ? 'auto' : { type: 'function', function: { name: choice.name } };
    default:
      return 'auto';
  }
}

/**
 * Stable hash binding an idempotency key to a body. Only the fields that shape
 * the generation are hashed, so a cosmetic field added by an SDK between
 * retries still replays rather than conflicts.
 */
export function messagesRequestHash(request: MessagesRequest): string {
  const canonical = {
    model: request.model,
    messages: request.messages,
    system: request.system ?? null,
    max_tokens: request.max_tokens,
    temperature: request.temperature ?? null,
    top_p: request.top_p ?? null,
    stop_sequences: request.stop_sequences ?? null,
    tools: request.tools ?? null,
    tool_choice: request.tool_choice ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
