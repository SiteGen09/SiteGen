import { describe, expect, it } from 'vitest';
import {
  chatCompletionRequestSchema,
  chatMessageSchema,
  chatRequestHash,
  totalMessageChars,
  totalToolChars,
  type ChatCompletionRequest,
  type ChatMessage,
  type ChatTool,
} from './request';

const WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Look up the weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
  },
} as const;

function parseBody(overrides: Record<string, unknown> = {}): ChatCompletionRequest {
  const parsed = chatCompletionRequestSchema.safeParse({
    model: 'sitegen-chat',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  });
  if (!parsed.success) {
    throw new Error(`unexpected parse failure: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

describe('chatMessageSchema', () => {
  it('accepts a tool-role message carrying an id and a body', () => {
    const parsed = chatMessageSchema.safeParse({
      role: 'tool',
      tool_call_id: 'call_1',
      name: 'get_weather',
      content: '{"tempC":11}',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an assistant message with tool_calls and null content', () => {
    const parsed = chatMessageSchema.safeParse({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a tool-role message missing tool_call_id', () => {
    const parsed = chatMessageSchema.safeParse({ role: 'tool', content: 'result' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toContain('tool_call_id');
  });

  it('rejects an assistant message with neither content nor tool_calls', () => {
    const parsed = chatMessageSchema.safeParse({ role: 'assistant' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path.join('.')).toBe('content');
  });

  it('rejects an assistant message whose tool_calls array is empty', () => {
    const parsed = chatMessageSchema.safeParse({ role: 'assistant', content: null, tool_calls: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects null content on a user message', () => {
    const parsed = chatMessageSchema.safeParse({ role: 'user', content: null });
    expect(parsed.success).toBe(false);
  });

  it('ignores unknown message keys', () => {
    const parsed = chatMessageSchema.safeParse({
      role: 'user',
      content: 'hi',
      reasoning_content: 'ignored',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('chatCompletionRequestSchema', () => {
  it('accepts tools with a string tool_choice', () => {
    const body = parseBody({ tools: [WEATHER_TOOL], tool_choice: 'required' });
    expect(body.tool_choice).toBe('required');
    expect(body.tools?.[0]?.function.name).toBe('get_weather');
  });

  it('accepts a named function tool_choice', () => {
    const body = parseBody({
      tools: [WEATHER_TOOL],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('rejects an unknown tool_choice string', () => {
    const parsed = chatCompletionRequestSchema.safeParse({
      model: 'sitegen-chat',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'sometimes',
    });
    expect(parsed.success).toBe(false);
  });

  it('reports the offending message index in the issue path', () => {
    const parsed = chatCompletionRequestSchema.safeParse({
      model: 'sitegen-chat',
      messages: [{ role: 'user', content: 'hi' }, { role: 'tool', content: 'result' }],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path.join('.')).toBe('messages.1.tool_call_id');
  });

  it('ignores unknown top-level keys', () => {
    const body = parseBody({ seed: 7, presence_penalty: 0.2 });
    expect(body.model).toBe('sitegen-chat');
  });
});

describe('totalMessageChars', () => {
  it('counts zero for null content and adds tool call name and arguments', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'ab', arguments: '{"c":1}' } },
        ],
      },
    ];
    expect(totalMessageChars(messages)).toBe(2 + 7);
  });

  it('counts plain content', () => {
    expect(totalMessageChars([{ role: 'user', content: 'hello' }])).toBe(5);
  });

  it('counts a tool result body', () => {
    expect(
      totalMessageChars([{ role: 'tool', tool_call_id: 'call_1', content: '12345' }]),
    ).toBe(5);
  });
});

describe('totalToolChars', () => {
  it('returns zero when no tools are declared', () => {
    expect(totalToolChars(undefined)).toBe(0);
  });

  it('counts the serialized function declaration', () => {
    const tools: ChatTool[] = [WEATHER_TOOL];
    expect(totalToolChars(tools)).toBe(JSON.stringify(WEATHER_TOOL.function).length);
  });
});

describe('chatRequestHash', () => {
  it('is stable when a cosmetic unknown field is added', () => {
    const base = parseBody({ tools: [WEATHER_TOOL] });
    const withExtra = parseBody({ tools: [WEATHER_TOOL], user: 'abc' });
    expect(chatRequestHash(withExtra)).toBe(chatRequestHash(base));
  });

  it('differs when tools differ', () => {
    const withTools = parseBody({ tools: [WEATHER_TOOL] });
    expect(chatRequestHash(withTools)).not.toBe(chatRequestHash(parseBody()));
  });

  it('differs when tool_choice differs', () => {
    const auto = parseBody({ tools: [WEATHER_TOOL], tool_choice: 'auto' });
    const required = parseBody({ tools: [WEATHER_TOOL], tool_choice: 'required' });
    expect(chatRequestHash(auto)).not.toBe(chatRequestHash(required));
  });
});
