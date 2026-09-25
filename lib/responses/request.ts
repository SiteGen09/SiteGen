import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ApiError } from '@/lib/api/errors';
import {
  attachmentFromUrl,
  checkAttachmentCount,
  unsupportedFileId,
  type ChatAttachment,
} from '@/lib/chat/attachments';
import type { ChatMessage, ChatTool, ChatToolChoice } from '@/lib/chat/request';

/**
 * One function tool in the flat Responses API shape. Parameters is a schema
 * object, not a JSON-Schema wrapper — the wire format differs from chat.
 */
const functionToolSchema = z.looseObject({
  type: z.literal('function'),
  name: z.string().min(1, 'tool name is required'),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Function tools grouped under a name. Codex sends its sub-agent, clock and
 * MCP tools this way, and a call to one comes back as a `function_call` that
 * carries the group in a `namespace` field. Chat completions has no groups,
 * so each member is offered upstream under a combined name (see
 * {@link namespacedToolName}) and mapped back on the way out.
 */
const namespaceToolSchema = z.looseObject({
  type: z.literal('namespace'),
  name: z.string().min(1, 'namespace name is required'),
  description: z.string().optional(),
  tools: z.array(functionToolSchema),
});

/**
 * Hosted tools (`web_search`, `tool_search`, `custom`, `image_generation`, ...)
 * are executed by OpenAI's own servers, which this gateway is not. They are
 * accepted and left out of the upstream call rather than failing the request,
 * so a client that always offers them (Codex does) still works.
 */
const hostedToolSchema = z.looseObject({
  type: z.string().refine((type) => type !== 'function' && type !== 'namespace'),
});

export const responsesToolSchema = z.union([functionToolSchema, namespaceToolSchema, hostedToolSchema]);

export type ResponsesTool = z.infer<typeof responsesToolSchema>;
type FunctionTool = z.infer<typeof functionToolSchema>;
type NamespaceTool = z.infer<typeof namespaceToolSchema>;

// A hosted tool's `type` is any other string, so comparing `type` alone does
// not narrow the union; these guards do.
function isFunctionTool(tool: ResponsesTool): tool is FunctionTool {
  return tool.type === 'function';
}

function isNamespaceTool(tool: ResponsesTool): tool is NamespaceTool {
  return tool.type === 'namespace';
}

/** A tool as the client named it: plain, or a member of a namespace. */
export interface ToolName {
  name: string;
  namespace?: string;
}

/** Chat completions (OpenAI's limit, which most upstreams share) caps names at 64. */
const TOOL_NAME_LIMIT = 64;

/**
 * The single name a namespace member is offered upstream under. Deterministic,
 * so the same tool gets the same name on every turn of a conversation; names
 * past the limit keep a readable prefix and a hash of the full pair.
 */
export function namespacedToolName(namespace: string, name: string): string {
  const joined = `${namespace}__${name}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (joined.length <= TOOL_NAME_LIMIT) return joined;
  const digest = createHash('sha256').update(`${namespace}\u0000${name}`, 'utf8').digest('hex').slice(0, 8);
  return `${joined.slice(0, TOOL_NAME_LIMIT - digest.length - 1)}_${digest}`;
}

/** Maps a tool name the upstream model called back to the client's name. */
export function toolNameResolver(request: ResponsesRequest): (upstreamName: string) => ToolName {
  const names = new Map<string, ToolName>();
  for (const tool of request.tools ?? []) {
    if (!isNamespaceTool(tool)) continue;
    for (const member of tool.tools) {
      names.set(namespacedToolName(tool.name, member.name), { name: member.name, namespace: tool.name });
    }
  }
  return (upstreamName) => names.get(upstreamName) ?? { name: upstreamName };
}

/** Types of the hosted tools {@link toChatTools} leaves out, for the log. */
export function hostedToolTypes(request: ResponsesRequest): string[] {
  return (request.tools ?? [])
    .filter((tool) => !isFunctionTool(tool) && !isNamespaceTool(tool))
    .map((tool) => tool.type);
}

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
 * input_text/output_text (role-specific) and plain text parts, plus an image
 * (`input_image`, which Codex sends for a pasted screenshot) and a file
 * (`input_file`, a PDF or text document).
 */
const textPartSchema = z.looseObject({
  type: z.enum(['input_text', 'output_text', 'text']),
  text: z.string(),
});

const imagePartSchema = z.looseObject({
  type: z.literal('input_image'),
  image_url: z.string().nullable().optional(),
  file_id: z.string().nullable().optional(),
});

const filePartSchema = z.looseObject({
  type: z.literal('input_file'),
  file_data: z.string().nullable().optional(),
  file_url: z.string().nullable().optional(),
  file_id: z.string().nullable().optional(),
  filename: z.string().nullable().optional(),
});

const contentPartSchema = z.union([textPartSchema, imagePartSchema, filePartSchema]);

type ContentPart = z.infer<typeof contentPartSchema>;

/** The attachment an image or file part carries, or null for any other part. */
function partAttachment(part: unknown): ChatAttachment | null {
  const parsed = z.union([imagePartSchema, filePartSchema]).safeParse(part);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (value.type === 'input_image') {
    if (!value.image_url) return unsupportedFileId();
    return attachmentFromUrl(value.image_url, { kind: 'image' });
  }
  const filename = value.filename ?? undefined;
  if (value.file_data) {
    // SDKs send either a data: URL or bare base64 here.
    return value.file_data.startsWith('data:')
      ? attachmentFromUrl(value.file_data, { filename })
      : attachmentFromUrl(`data:;base64,${value.file_data}`, { filename });
  }
  if (value.file_url) return attachmentFromUrl(value.file_url, { filename });
  return unsupportedFileId();
}

function partsAttachments(parts: readonly unknown[]): ChatAttachment[] {
  return parts.flatMap((part) => partAttachment(part) ?? []);
}

function partsText(parts: readonly ContentPart[]): string {
  return parts.map((part) => ('text' in part && typeof part.text === 'string' ? part.text : '')).join('');
}

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
  /** Set when the call was to a member of a `namespace` tool. */
  namespace: z.string().optional(),
  arguments: z.string(),
});

/**
 * A tool's result. Usually a string; a result carrying an image (an MCP
 * screenshot tool, say) arrives as content parts instead. Text parts become
 * the tool message; images and files ride along as its attachments, and any
 * other part is noted.
 */
const functionCallOutputItemSchema = z.looseObject({
  type: z.literal('function_call_output'),
  call_id: z.string().min(1, 'call_id is required'),
  output: z.union([z.string(), z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))]),
});

function outputText(output: z.infer<typeof functionCallOutputItemSchema>['output']): string {
  if (typeof output === 'string') return output;
  return output
    .flatMap((part) => {
      if (part.text !== undefined) return [part.text];
      if (part.type === 'input_image' || part.type === 'input_file') return [];
      return [`[${part.type} omitted: this gateway does not accept that kind of tool output]`];
    })
    .join('\n');
}

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
      // Replayed under the same combined name the tool was offered with.
      const name = item.namespace ? namespacedToolName(item.namespace, item.name) : item.name;
      pendingToolCalls.push({
        id: item.call_id,
        type: 'function',
        function: { name, arguments: item.arguments },
      });
      continue;
    }

    if (item.type === 'function_call_output') {
      flushToolCalls();
      const attachments = typeof item.output === 'string' ? [] : partsAttachments(item.output);
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: outputText(item.output),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      continue;
    }

    flushToolCalls();
    const role = item.role === 'developer' ? 'system' : item.role;
    if (typeof item.content === 'string') {
      messages.push({ role, content: item.content });
      continue;
    }
    const attachments = partsAttachments(item.content);
    if (attachments.length > 0 && role !== 'user') {
      throw new ApiError(
        'invalid_request',
        `images and files are only accepted in user messages and tool outputs, not ${item.role} messages`,
        400,
      );
    }
    messages.push({ role, content: partsText(item.content), ...(attachments.length > 0 ? { attachments } : {}) });
  }

  // Flush any remaining tool calls at the end.
  flushToolCalls();

  checkAttachmentCount(messages.reduce((sum, message) => sum + (message.attachments?.length ?? 0), 0));
  return messages;
}

function toChatTool(name: string, tool: FunctionTool): ChatTool {
  const fn: { name: string; description?: string; parameters?: Record<string, unknown> } = { name };

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
}

/**
 * Lift flat Responses API tools to the nested chat completions shape.
 * Absent optional keys are omitted entirely. Namespace members become
 * individual tools under their combined name; hosted tools are left out, and
 * a request that offered nothing else is sent without tools.
 */
export function toChatTools(request: ResponsesRequest): ChatTool[] | undefined {
  if (request.tools === undefined) {
    return undefined;
  }

  const tools: ChatTool[] = [];
  for (const tool of request.tools) {
    if (isFunctionTool(tool)) {
      tools.push(toChatTool(tool.name, tool));
    } else if (isNamespaceTool(tool)) {
      for (const member of tool.tools) {
        tools.push(toChatTool(namespacedToolName(tool.name, member.name), member));
      }
    }
  }
  return tools.length > 0 || request.tools.length === 0 ? tools : undefined;
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
