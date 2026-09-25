import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  attachmentChars,
  attachmentFromUrl,
  unsupportedFileId,
  type ChatAttachment,
} from '@/lib/chat/attachments';

/**
 * One function tool as OpenAI clients declare it. Loose for the same reason as
 * the body below: SDKs attach fields we do not model (`strict`, …).
 */
export const chatToolFunctionSchema = z.looseObject({
  name: z.string().min(1, 'tool function name is required'),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const chatToolSchema = z.looseObject({
  type: z.literal('function'),
  function: chatToolFunctionSchema,
});

export type ChatTool = z.infer<typeof chatToolSchema>;

export const chatToolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.looseObject({
    type: z.literal('function'),
    function: z.looseObject({ name: z.string().min(1, 'tool name is required') }),
  }),
]);

export type ChatToolChoice = z.infer<typeof chatToolChoiceSchema>;

/**
 * A tool call replayed back to us on a follow-up turn. `type` is optional
 * because some clients omit it when echoing our own response.
 */
export const chatToolCallSchema = z.looseObject({
  id: z.string().min(1, 'tool call id is required'),
  type: z.literal('function').optional(),
  function: z.looseObject({
    name: z.string().min(1, 'tool call function name is required'),
    arguments: z.string(),
  }),
});

export type ChatToolCall = z.infer<typeof chatToolCallSchema>;

/**
 * OpenAI chat-completions request shape.
 *
 * Deliberately a loose object, not a strict one: OpenAI clients routinely send
 * fields we do not model (`user`, `presence_penalty`, `seed`, …) and rejecting
 * them would break real SDKs. Unknown keys are ignored. This differs on purpose
 * from `lib/generate/request.ts`, whose body is strict.
 */
/**
 * OpenAI's multimodal content parts: text, an image (`image_url`) and an
 * inline file (`file.file_data`, a PDF or text document).
 */
const chatContentPartSchema = z.union([
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({
    type: z.literal('image_url'),
    image_url: z.union([z.string(), z.looseObject({ url: z.string() })]),
  }),
  z.looseObject({
    type: z.literal('file'),
    file: z.looseObject({
      file_data: z.string().optional(),
      file_id: z.string().optional(),
      filename: z.string().optional(),
    }),
  }),
]);

type ChatContentPart = z.infer<typeof chatContentPartSchema>;

function partAttachment(part: Exclude<ChatContentPart, { type: 'text' }>): ChatAttachment {
  if (part.type === 'image_url') {
    return attachmentFromUrl(typeof part.image_url === 'string' ? part.image_url : part.image_url.url, { kind: 'image' });
  }
  if (part.file.file_data === undefined) return unsupportedFileId();
  const filename = part.file.filename;
  // SDKs send either a data: URL or bare base64 here.
  return part.file.file_data.startsWith('data:')
    ? attachmentFromUrl(part.file.file_data, { filename })
    : attachmentFromUrl(`data:;base64,${part.file.file_data}`, { filename });
}

export const chatMessageSchema = z
  .looseObject({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(chatContentPartSchema)]).nullable().optional(),
    name: z.string().optional(),
    tool_calls: z.array(chatToolCallSchema).optional(),
    tool_call_id: z.string().optional(),
  })
  .check((ctx) => {
    const message = ctx.value;
    if (message.role === 'tool') {
      if (message.tool_call_id === undefined) {
        ctx.issues.push({
          code: 'custom',
          message: 'tool_call_id is required for a tool message',
          input: message,
          path: ['tool_call_id'],
        });
      }
      if (message.content === undefined || message.content === null) {
        ctx.issues.push({
          code: 'custom',
          message: 'content is required for a tool message',
          input: message,
          path: ['content'],
        });
      }
      return;
    }

    if (Array.isArray(message.content) && message.role !== 'user'
      && message.content.some((part) => part.type !== 'text')) {
      ctx.issues.push({
        code: 'custom',
        message: `images and files are only accepted in user and tool messages, not ${message.role} messages`,
        input: message,
        path: ['content'],
      });
      return;
    }

    if (typeof message.content === 'string' || Array.isArray(message.content)) {
      return;
    }

    if (message.role === 'assistant') {
      // A turn that is only tool calls carries no content at all.
      if (message.tool_calls === undefined || message.tool_calls.length === 0) {
        ctx.issues.push({
          code: 'custom',
          message: 'an assistant message requires content or tool_calls',
          input: message,
          path: ['content'],
        });
      }
      return;
    }

    ctx.issues.push({
      code: 'custom',
      message: `content is required for a ${message.role} message`,
      input: message,
      path: ['content'],
    });
  })
  // Content parts collapse to the text plus attachments every wire format
  // translates into. A client-supplied `attachments` key is never trusted.
  .transform((message, ctx) => {
    const { attachments: _untrusted, content, ...rest } = message;
    if (!Array.isArray(content)) return { ...rest, content } as ChatMessage;
    const text = content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
    const attachments: ChatAttachment[] = [];
    for (const part of content) {
      if (part.type === 'text') continue;
      try {
        attachments.push(partAttachment(part));
      } catch (error) {
        ctx.issues.push({
          code: 'custom',
          message: error instanceof Error ? error.message : 'an attachment could not be read',
          input: part,
          path: ['content'],
        });
        return z.NEVER;
      }
    }
    return { ...rest, content: text, ...(attachments.length > 0 ? { attachments } : {}) } as ChatMessage;
  });

/**
 * One chat message as the pipeline carries it. `attachments` holds the images
 * and documents any wire format delivered; only user and tool messages carry
 * them.
 */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  name?: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  attachments?: ChatAttachment[];
  [key: string]: unknown;
};

export const chatCompletionRequestSchema = z.looseObject({
  model: z.string().min(1, 'model is required'),
  messages: z.array(chatMessageSchema).min(1, 'at least one message is required'),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(),
  /**
   * OpenAI's opt-in for a final usage chunk on a stream. Clients that bill or
   * display token counts set it; without it the stream carries no usage, which
   * is what the OpenAI SDK expects by default.
   */
  stream_options: z
    .object({ include_usage: z.boolean().optional() })
    .loose()
    .optional(),
  tools: z.array(chatToolSchema).optional(),
  tool_choice: chatToolChoiceSchema.optional(),
  /** Passed through as the SDK's reasoning level; unknown levels are ignored. */
  reasoning_effort: z.string().nullish(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

/** Total characters across every message, for the coarse hold estimate. */
export function totalMessageChars(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += message.content?.length ?? 0;
    for (const attachment of message.attachments ?? []) {
      total += attachmentChars(attachment);
    }
    for (const call of message.tool_calls ?? []) {
      total += call.function.name.length + call.function.arguments.length;
    }
  }
  return total;
}

/**
 * Characters across every tool declaration. Tool schemas are prompt input the
 * model is billed for, so the hold has to cover them.
 */
export function totalToolChars(tools: readonly ChatTool[] | undefined): number {
  if (tools === undefined) {
    return 0;
  }
  let total = 0;
  for (const entry of tools) {
    total += JSON.stringify(entry.function).length;
  }
  return total;
}

/**
 * Stable hash binding an idempotency key to a body. Only the fields that shape
 * the generation are hashed, so an SDK that adds a cosmetic field between
 * retries still replays rather than conflicts.
 */
export function chatRequestHash(request: ChatCompletionRequest): string {
  const canonical = {
    model: request.model,
    messages: request.messages,
    max_tokens: request.max_tokens ?? null,
    temperature: request.temperature ?? null,
    top_p: request.top_p ?? null,
    stop: request.stop ?? null,
    tools: request.tools ?? null,
    tool_choice: request.tool_choice ?? null,
    reasoning_effort: request.reasoning_effort ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
