import {
  jsonSchema,
  tool,
  type JSONSchema7,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
} from 'ai';

import type { ChatMessage, ChatTool, ChatToolChoice } from '@/lib/chat/request';

/** OpenAI wire shape for one tool call. */
export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** One tool call as the AI SDK reports it. */
export interface SdkToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** OpenAI lets `parameters` be omitted; the SDK still needs a schema. */
const NO_PARAMETERS: JSONSchema7 = { type: 'object', properties: {} };

/**
 * Translate declared tools into an SDK tool set.
 *
 * Every entry is defined without `execute`: that omission is what makes the SDK
 * stop at the tool call and hand it back to us, which is the only correct
 * behaviour for a gateway — the caller's tools are the caller's to run.
 */
export function toToolSet(tools: readonly ChatTool[] | undefined): ToolSet | undefined {
  if (tools === undefined || tools.length === 0) {
    return undefined;
  }

  const toolSet: ToolSet = {};
  for (const entry of tools) {
    const { name, description, parameters } = entry.function;
    // Later duplicates win, matching OpenAI.
    toolSet[name] = tool({
      description,
      inputSchema: jsonSchema(
        parameters === undefined ? NO_PARAMETERS : (parameters as unknown as JSONSchema7),
      ),
    });
  }
  return toolSet;
}

export function toToolChoice(choice: ChatToolChoice | undefined): ToolChoice<ToolSet> | undefined {
  if (choice === undefined) {
    return undefined;
  }
  if (typeof choice === 'string') {
    return choice;
  }
  return { type: 'tool', toolName: choice.function.name };
}

/**
 * Arguments arrive as a JSON string on the wire. A gateway forwards what the
 * client sent; it does not adjudicate the client's own tool arguments, so
 * unparseable input degrades to an empty object rather than a 500.
 */
function parseToolArguments(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

export function toModelMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  const converted: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      converted.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.tool_call_id ?? '',
            toolName: message.name ?? '',
            output: { type: 'text', value: message.content ?? '' },
          },
        ],
      });
      continue;
    }

    if (message.role === 'assistant') {
      const calls = message.tool_calls;
      if (calls !== undefined && calls.length > 0) {
        converted.push({
          role: 'assistant',
          content: [
            ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
            ...calls.map((call) => ({
              type: 'tool-call' as const,
              toolCallId: call.id,
              toolName: call.function.name,
              input: parseToolArguments(call.function.arguments),
            })),
          ],
        });
        continue;
      }
      converted.push({ role: 'assistant', content: message.content ?? '' });
      continue;
    }

    converted.push({ role: message.role, content: message.content ?? '' });
  }

  return converted;
}

/**
 * Everything a moderation pass should see. A tool result and a tool call's
 * arguments are message content too, so they are screened alongside text.
 */
export function moderationText(messages: readonly ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      parts.push(message.content);
    }
    for (const call of message.tool_calls ?? []) {
      parts.push(call.function.name);
      parts.push(call.function.arguments);
    }
  }
  return parts.join('\n');
}

/** The SDK already emits `stop` and `length` verbatim; only these two differ. */
export function openAiFinishReason(finishReason: string): string {
  if (finishReason === 'tool-calls') {
    return 'tool_calls';
  }
  if (finishReason === 'content-filter') {
    return 'content_filter';
  }
  return finishReason;
}

export function toOpenAiToolCalls(calls: readonly SdkToolCall[]): OpenAiToolCall[] {
  return calls.map((call) => ({
    id: call.toolCallId,
    type: 'function',
    function: { name: call.toolName, arguments: JSON.stringify(call.input ?? {}) },
  }));
}
