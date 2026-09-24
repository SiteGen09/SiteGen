import { describe, expect, it } from 'vitest';

import {
  messagesRequestHash,
  messagesRequestSchema,
  toChatMessages,
  toChatToolChoice,
  toChatTools,
  type MessagesRequest,
} from './request';

function parse(raw: unknown): MessagesRequest {
  const result = messagesRequestSchema.safeParse(raw);
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? 'invalid');
  return result.data;
}

const base = { model: 'claude-sonnet-5', max_tokens: 100 };

describe('messagesRequestSchema', () => {
  it('requires max_tokens, unlike the OpenAI formats', () => {
    expect(
      messagesRequestSchema.safeParse({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
        .success,
    ).toBe(false);
  });

  it('ignores fields real SDKs attach but we do not model', () => {
    const request = parse({
      ...base,
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { user_id: 'u1' },
      service_tier: 'auto',
    });
    expect(toChatMessages(request)).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('toChatMessages', () => {
  it('lifts system out of the top level into a leading message', () => {
    const request = parse({
      ...base,
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(toChatMessages(request)).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('flattens a block-array system prompt', () => {
    const request = parse({
      ...base,
      system: [
        { type: 'text', text: 'be ' },
        { type: 'text', text: 'brief' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(toChatMessages(request)[0]).toEqual({ role: 'system', content: 'be brief' });
  });

  it('drops an empty system prompt rather than sending a blank turn', () => {
    const request = parse({ ...base, system: '', messages: [{ role: 'user', content: 'hi' }] });
    expect(toChatMessages(request)).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('concatenates text blocks in a message', () => {
    const request = parse({
      ...base,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'one ' },
            { type: 'text', text: 'two' },
          ],
        },
      ],
    });
    expect(toChatMessages(request)).toEqual([{ role: 'user', content: 'one two' }]);
  });

  it('turns tool_use into assistant tool_calls with stringified arguments', () => {
    const request = parse({
      ...base,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'x' } }],
        },
      ],
    });
    expect(toChatMessages(request)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      },
    ]);
  });

  it('keeps assistant prose that accompanies a tool call', () => {
    const request = parse({
      ...base,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', id: 'tu_1', name: 'lookup', input: {} },
          ],
        },
      ],
    });
    const [message] = toChatMessages(request);
    expect(message?.content).toBe('let me check');
    expect(message?.tool_calls).toHaveLength(1);
  });

  it('lifts a tool_result out of its user turn into a tool message', () => {
    const request = parse({
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'done' }] },
      ],
    });
    // The user turn carried nothing but the result, so no user message remains.
    expect(toChatMessages(request)).toEqual([
      { role: 'tool', tool_call_id: 'tu_1', content: 'done' },
    ]);
  });

  it('keeps user text that follows a tool result in the same turn', () => {
    const request = parse({
      ...base,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'done' },
            { type: 'text', text: 'now what?' },
          ],
        },
      ],
    });
    expect(toChatMessages(request)).toEqual([
      { role: 'tool', tool_call_id: 'tu_1', content: 'done' },
      { role: 'user', content: 'now what?' },
    ]);
  });

  it('flattens a block-array tool result', () => {
    const request = parse({
      ...base,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
            },
          ],
        },
      ],
    });
    expect(toChatMessages(request)[0]?.content).toBe('ab');
  });

  it('represents an omitted tool_result body as empty, not missing', () => {
    // chat completions requires a string on a tool message; undefined would
    // fail its own schema further down the pipeline.
    const request = parse({
      ...base,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] }],
    });
    expect(toChatMessages(request)).toEqual([{ role: 'tool', tool_call_id: 'tu_1', content: '' }]);
  });
});

describe('toChatTools', () => {
  it('nests the flat Anthropic tool shape and renames input_schema', () => {
    const request = parse({
      ...base,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'lookup', description: 'find', input_schema: { type: 'object' } }],
    });
    expect(toChatTools(request)).toEqual([
      {
        type: 'function',
        function: { name: 'lookup', description: 'find', parameters: { type: 'object' } },
      },
    ]);
  });

  it('omits absent optional keys entirely', () => {
    const request = parse({
      ...base,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'lookup' }],
    });
    expect(toChatTools(request)).toEqual([{ type: 'function', function: { name: 'lookup' } }]);
  });

  it('is undefined when no tools are declared', () => {
    expect(toChatTools(parse({ ...base, messages: [{ role: 'user', content: 'hi' }] }))).toBeUndefined();
  });
});

describe('toChatToolChoice', () => {
  const withChoice = (tool_choice: unknown): MessagesRequest =>
    parse({ ...base, messages: [{ role: 'user', content: 'hi' }], tool_choice });

  it("maps Anthropic's any to required", () => {
    expect(toChatToolChoice(withChoice({ type: 'any' }))).toBe('required');
  });

  it('passes auto and none through', () => {
    expect(toChatToolChoice(withChoice({ type: 'auto' }))).toBe('auto');
    expect(toChatToolChoice(withChoice({ type: 'none' }))).toBe('none');
  });

  it('nests a named tool under function', () => {
    expect(toChatToolChoice(withChoice({ type: 'tool', name: 'lookup' }))).toEqual({
      type: 'function',
      function: { name: 'lookup' },
    });
  });

  it('falls back to auto for a nameless tool choice', () => {
    // Sending a malformed choice upstream would fail the call outright.
    expect(toChatToolChoice(withChoice({ type: 'tool' }))).toBe('auto');
  });
});

describe('messagesRequestHash', () => {
  it('ignores cosmetic fields so a retry replays', () => {
    const one = parse({ ...base, messages: [{ role: 'user', content: 'hi' }] });
    const two = parse({ ...base, messages: [{ role: 'user', content: 'hi' }], metadata: { a: 1 } });
    expect(messagesRequestHash(one)).toBe(messagesRequestHash(two));
  });

  it('changes when the generation would change', () => {
    const one = parse({ ...base, messages: [{ role: 'user', content: 'hi' }] });
    const two = parse({ ...base, messages: [{ role: 'user', content: 'hello' }] });
    expect(messagesRequestHash(one)).not.toBe(messagesRequestHash(two));
  });

  it('separates requests that differ only by system prompt', () => {
    const one = parse({ ...base, messages: [{ role: 'user', content: 'hi' }] });
    const two = parse({ ...base, system: 'be brief', messages: [{ role: 'user', content: 'hi' }] });
    expect(messagesRequestHash(one)).not.toBe(messagesRequestHash(two));
  });
});
