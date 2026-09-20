import { describe, expect, it } from 'vitest';
import {
  responsesRequestHash,
  responsesRequestSchema,
  toChatMessages,
  toChatToolChoice,
  toChatTools,
  type ResponsesRequest,
} from './request';

const WEATHER_TOOL = {
  type: 'function',
  name: 'get_weather',
  description: 'Get current weather',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string' },
    },
  },
} as const;

function parseBody(overrides: Record<string, unknown> = {}): ResponsesRequest {
  const parsed = responsesRequestSchema.safeParse({
    model: 'gpt-4',
    input: 'Hello',
    ...overrides,
  });
  if (!parsed.success) {
    throw new Error(`unexpected parse failure: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

describe('responsesRequestSchema', () => {
  it('accepts a string input', () => {
    const body = parseBody({ input: 'Hello, world!' });
    expect(body.input).toBe('Hello, world!');
  });

  it('accepts an array input with message items', () => {
    const body = parseBody({
      input: [
        { role: 'user', content: 'Hello' },
        { type: 'message', role: 'assistant', content: 'Hi there' },
      ],
    });
    expect(Array.isArray(body.input)).toBe(true);
  });

  it('accepts function_call and function_call_output items', () => {
    const body = parseBody({
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
      ],
    });
    expect(Array.isArray(body.input)).toBe(true);
  });

  it('accepts optional id field on function_call items', () => {
    const body = parseBody({
      input: [
        { type: 'function_call', call_id: 'call_1', id: 'call_1', name: 'get_weather', arguments: '{}' },
      ],
    });
    expect(Array.isArray(body.input)).toBe(true);
  });

  it('rejects missing input', () => {
    const parsed = responsesRequestSchema.safeParse({ model: 'gpt-4' });
    expect(parsed.success).toBe(false);
  });

  it('rejects empty input array', () => {
    const parsed = responsesRequestSchema.safeParse({ model: 'gpt-4', input: [] });
    expect(parsed.success).toBe(false);
  });

  it('ignores unknown top-level fields', () => {
    const body = parseBody({ custom_field: 'ignored', another: 42 });
    // Loose objects retain unknown fields in the parsed output.
    expect(body.model).toBe('gpt-4');
    expect(body.input).toBe('Hello');
  });

  it('accepts optional instructions field', () => {
    const body = parseBody({ instructions: 'You are a helpful assistant.' });
    expect(body.instructions).toBe('You are a helpful assistant.');
  });

  it('accepts optional max_output_tokens', () => {
    const body = parseBody({ max_output_tokens: 1024 });
    expect(body.max_output_tokens).toBe(1024);
  });

  it('accepts optional temperature and top_p', () => {
    const body = parseBody({ temperature: 0.7, top_p: 0.9 });
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
  });

  it('accepts flat tool shape', () => {
    const body = parseBody({ tools: [WEATHER_TOOL] });
    expect(body.tools).toHaveLength(1);
    expect(body.tools?.[0]?.name).toBe('get_weather');
  });

  it('accepts tool_choice as string', () => {
    const body = parseBody({ tool_choice: 'auto' });
    expect(body.tool_choice).toBe('auto');
  });

  it('accepts tool_choice as object', () => {
    const body = parseBody({ tool_choice: { type: 'function', name: 'get_weather' } });
    expect(typeof body.tool_choice).toBe('object');
  });
});

describe('toChatMessages', () => {
  it('converts string input to a single user message', () => {
    const request = parseBody({ input: 'Hello, world!' });
    const messages = toChatMessages(request);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'user', content: 'Hello, world!' });
  });

  it('converts instructions to a leading system message', () => {
    const request = parseBody({
      input: 'Hello',
      instructions: 'You are a helpful assistant.',
    });
    const messages = toChatMessages(request);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('does not add a system message when instructions is empty', () => {
    const request = parseBody({ input: 'Hello', instructions: '' });
    const messages = toChatMessages(request);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it('maps developer role to system', () => {
    const request = parseBody({
      input: [{ role: 'developer', content: 'System context' }],
    });
    const messages = toChatMessages(request);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'system', content: 'System context' });
  });

  it('concatenates content part arrays with no separator', () => {
    const request = parseBody({
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Hello' },
            { type: 'input_text', text: ' ' },
            { type: 'input_text', text: 'world' },
          ],
        },
      ],
    });
    const messages = toChatMessages(request);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'user', content: 'Hello world' });
  });

  it('merges consecutive function_call items into one assistant message', () => {
    const request = parseBody({
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"location":"NYC"}' },
        { type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '{}' },
      ],
    });
    const messages = toChatMessages(request);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.content).toBe(null);
    expect(messages[0]?.tool_calls).toHaveLength(2);
    expect(messages[0]?.tool_calls?.[0]?.id).toBe('call_1');
    expect(messages[0]?.tool_calls?.[1]?.id).toBe('call_2');
  });

  it('does not merge non-adjacent function_call items', () => {
    const request = parseBody({
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
        { type: 'function_call', call_id: 'call_2', name: 'get_time', arguments: '{}' },
      ],
    });
    const messages = toChatMessages(request);

    expect(messages).toHaveLength(3);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.tool_calls).toHaveLength(1);
    expect(messages[1]?.role).toBe('tool');
    expect(messages[2]?.role).toBe('assistant');
    expect(messages[2]?.tool_calls).toHaveLength(1);
  });

  it('converts function_call_output to a tool message with tool_call_id', () => {
    const request = parseBody({
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
      ],
    });
    const messages = toChatMessages(request);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'sunny',
    });
  });

  it('handles mixed message types in order', () => {
    const request = parseBody({
      input: [
        { role: 'user', content: 'What is the weather?' },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
        { role: 'assistant', content: 'It is sunny.' },
      ],
    });
    const messages = toChatMessages(request);

    expect(messages).toHaveLength(4);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[2]?.role).toBe('tool');
    expect(messages[3]?.role).toBe('assistant');
  });
});

describe('toChatTools', () => {
  it('returns undefined when tools is absent', () => {
    const request = parseBody({});
    const tools = toChatTools(request);

    expect(tools).toBeUndefined();
  });

  it('lifts flat tool to nested chat shape', () => {
    const request = parseBody({ tools: [WEATHER_TOOL] });
    const tools = toChatTools(request);

    expect(tools).toHaveLength(1);
    expect(tools?.[0]).toEqual({
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather',
        parameters: {
          type: 'object',
          properties: {
            location: { type: 'string' },
          },
        },
      },
    });
  });

  it('omits absent optional keys', () => {
    const request = parseBody({
      tools: [{ type: 'function', name: 'simple_tool' }],
    });
    const tools = toChatTools(request);

    expect(tools).toHaveLength(1);
    expect(tools?.[0]).toEqual({
      type: 'function',
      function: {
        name: 'simple_tool',
      },
    });
    expect(tools?.[0]?.function).not.toHaveProperty('description');
    expect(tools?.[0]?.function).not.toHaveProperty('parameters');
  });
});

describe('toChatToolChoice', () => {
  it('returns undefined when tool_choice is absent', () => {
    const request = parseBody({});
    const choice = toChatToolChoice(request);

    expect(choice).toBeUndefined();
  });

  it('passes through string tool_choice', () => {
    const request = parseBody({ tool_choice: 'auto' });
    const choice = toChatToolChoice(request);

    expect(choice).toBe('auto');
  });

  it('translates object tool_choice to nested shape', () => {
    const request = parseBody({
      tool_choice: { type: 'function', name: 'get_weather' },
    });
    const choice = toChatToolChoice(request);

    expect(choice).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
  });
});

describe('responsesRequestHash', () => {
  it('produces a stable hash for the same request', () => {
    const request = parseBody({ input: 'Hello' });
    const hash1 = responsesRequestHash(request);
    const hash2 = responsesRequestHash(request);

    expect(hash1).toBe(hash2);
  });

  it('produces the same hash when a cosmetic field is added', () => {
    const request1 = parseBody({ input: 'Hello' });
    const request2 = parseBody({ input: 'Hello', custom_field: 'ignored' });

    const hash1 = responsesRequestHash(request1);
    const hash2 = responsesRequestHash(request2);

    expect(hash1).toBe(hash2);
  });

  it('produces a different hash when input changes', () => {
    const request1 = parseBody({ input: 'Hello' });
    const request2 = parseBody({ input: 'Goodbye' });

    const hash1 = responsesRequestHash(request1);
    const hash2 = responsesRequestHash(request2);

    expect(hash1).not.toBe(hash2);
  });

  it('produces a different hash when instructions change', () => {
    const request1 = parseBody({ input: 'Hello', instructions: 'Be helpful' });
    const request2 = parseBody({ input: 'Hello', instructions: 'Be concise' });

    const hash1 = responsesRequestHash(request1);
    const hash2 = responsesRequestHash(request2);

    expect(hash1).not.toBe(hash2);
  });

  it('produces a different hash when max_output_tokens changes', () => {
    const request1 = parseBody({ input: 'Hello', max_output_tokens: 100 });
    const request2 = parseBody({ input: 'Hello', max_output_tokens: 200 });

    const hash1 = responsesRequestHash(request1);
    const hash2 = responsesRequestHash(request2);

    expect(hash1).not.toBe(hash2);
  });

  it('produces a different hash when tools change', () => {
    const request1 = parseBody({ input: 'Hello', tools: [WEATHER_TOOL] });
    const request2 = parseBody({ input: 'Hello', tools: [] });

    const hash1 = responsesRequestHash(request1);
    const hash2 = responsesRequestHash(request2);

    expect(hash1).not.toBe(hash2);
  });
});
