import { describe, expect, it } from 'vitest';
import { toModelMessages } from '@/lib/chat/tools';
import { detectLoop, toolHistory } from '@/lib/gensite/loops';

import {
  messagesRequestHash,
  messagesRequestSchema,
  nativeWebSearch,
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
  it('preserves explicit tool errors through normalization and upstream conversion', () => {
    const messages = toChatMessages(parse({
      ...base,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'failed', name: 'Edit', input: { old_string: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'failed', content: 'No matching text', is_error: true }] },
      ],
    }));
    expect(messages[1]).toMatchObject({ tool_call_id: 'failed', content: 'No matching text', tool_result_error: true });
    expect(toolHistory(messages)[0]?.failed).toBe(true);
    expect(toModelMessages(messages)[1]).toMatchObject({ content: [{ output: { type: 'error-text', value: 'No matching text' } }] });
  });

  it('recognizes repeated changed writes from real Anthropic error envelopes', () => {
    const messages = toChatMessages(parse({
      ...base,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'write large file one' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: "bash: unexpected EOF while looking for matching quote", is_error: true }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'package.json' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: '{}' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'write large file two' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: "bash: unexpected EOF while looking for matching quote", is_error: true }] },
      ],
    }));
    expect(detectLoop(toolHistory(messages))).toMatchObject({ kind: 'recurring-failure', failure: 'shell-quoting', count: 2 });
  });

  it('honors explicit successful output even when it contains error examples', () => {
    const messages = toChatMessages(parse({
      ...base,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'ok', name: 'Read', input: { file_path: 'fixture.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ok', content: 'Error: example', is_error: false }] },
      ],
    }));
    expect(toolHistory(messages)[0]?.failed).toBe(false);
    expect(toModelMessages(messages)[1]).toMatchObject({ content: [{ output: { type: 'text', value: 'Error: example' } }] });
  });

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

  it('accepts the mid-conversation system messages Claude Code sends', () => {
    const request = parse({
      ...base,
      system: [{ type: 'text', text: 'You are Claude Code.' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'context' }, { type: 'text', text: ' and task' }] },
        { role: 'system', content: [{ type: 'text', text: 'Available agent types: explore' }] },
      ],
    });
    expect(toChatMessages(request)).toEqual([
      { role: 'system', content: 'You are Claude Code.' },
      { role: 'user', content: 'context and task' },
      { role: 'user', content: '<system-reminder>\nAvailable agent types: explore\n</system-reminder>' },
    ]);
  });

  it('keeps a system message that precedes every turn as system', () => {
    const request = parse({
      ...base,
      system: 'base',
      messages: [
        { role: 'system', content: 'extra rules' },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(toChatMessages(request)).toEqual([
      { role: 'system', content: 'base' },
      { role: 'system', content: 'extra rules' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('drops an empty mid-conversation system message', () => {
    const request = parse({
      ...base,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: [] },
      ],
    });
    expect(toChatMessages(request)).toEqual([{ role: 'user', content: 'hi' }]);
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

  it('carries a pasted image and a PDF document on the user turn', () => {
    const request = parse({
      ...base,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'document', title: 'spec.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
          { type: 'text', text: 'Review these.' },
        ],
      }],
    });
    expect(toChatMessages(request)).toEqual([{
      role: 'user',
      content: 'Review these.',
      attachments: [
        { data: 'data:image/png;base64,AAAA', mediaType: 'image/png' },
        { data: 'data:application/pdf;base64,JVBERi0=', mediaType: 'application/pdf', filename: 'spec.pdf' },
      ],
    }]);
  });

  it('keeps an image a tool returned, as Claude Code reading a screenshot does', () => {
    const request = parse({
      ...base,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }],
        }],
      }],
    });
    expect(toChatMessages(request)).toEqual([{
      role: 'tool',
      tool_call_id: 'tu_1',
      content: '',
      attachments: [{ data: 'data:image/jpeg;base64,BBBB', mediaType: 'image/jpeg' }],
    }]);
  });

  it('refuses a Files API reference it cannot resolve', () => {
    const request = parse({
      ...base,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'file_1' } }] }],
    });
    expect(() => toChatMessages(request)).toThrow(/file_id/);
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

describe('the web_search server tool', () => {
  const searchTool = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 8,
    allowed_domains: ['docs.example.com'],
  };

  it('is read as a gateway search and left out of the upstream tools', () => {
    const request = parse({
      ...base,
      messages: [{ role: 'user', content: 'Perform a web search for the query: sitegen' }],
      tools: [searchTool, { name: 'Bash', input_schema: { type: 'object' } }],
    });
    expect(nativeWebSearch(request)).toEqual({
      name: 'web_search', maxUses: 8, allowedDomains: ['docs.example.com'], blockedDomains: undefined,
    });
    expect(toChatTools(request)?.map((tool) => tool.function.name)).toEqual(['Bash']);
  });

  it('is absent when the caller declared only its own tools', () => {
    expect(nativeWebSearch(parse({ ...base, messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'Bash' }] }))).toBeNull();
  });

  it('accepts replayed search blocks and keeps the results as text', () => {
    const messages = toChatMessages(parse({
      ...base,
      messages: [
        { role: 'user', content: 'what is new?' },
        {
          role: 'assistant',
          content: [
            { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'news' } },
            { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', title: 'A', url: 'https://a.test', encrypted_content: 'x' }] },
            { type: 'text', text: 'Here is the news.' },
          ],
        },
        { role: 'user', content: 'thanks' },
      ],
    }));
    expect(messages[1]).toEqual({ role: 'assistant', content: '\n[Web search results]\n- A — https://a.test\nHere is the news.' });
  });
});
