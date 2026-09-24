import { describe, expect, it } from 'vitest';

import type { NormalizedUsage } from '@/lib/generate/usage';
import { anthropicStopReason, createMessageFrames, messageObject } from './response';

const usage: NormalizedUsage = { inputTokens: 10, outputTokens: 5, cachedTokens: 3 };

/** Parses the `data:` payloads out of one or more concatenated SSE frames. */
function frames(raw: string): Array<{ event: string; data: Record<string, unknown> }> {
  return raw
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

describe('anthropicStopReason', () => {
  it('maps the chat completions vocabulary to Anthropic’s', () => {
    expect(anthropicStopReason('stop')).toBe('end_turn');
    expect(anthropicStopReason('length')).toBe('max_tokens');
    expect(anthropicStopReason('tool-calls')).toBe('tool_use');
    expect(anthropicStopReason(null)).toBeNull();
  });
});

describe('messageObject', () => {
  it('reports uncached input and cache reads separately', () => {
    // Anthropic splits these where chat completions folds them together.
    const body = messageObject({
      requestId: 'r1',
      model: 'claude-sonnet-5',
      content: 'hi',
      toolCalls: [],
      finishReason: 'stop',
      usage,
    });
    expect(body['usage']).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 0,
    });
  });

  it('emits no text block for a tool-only reply', () => {
    const body = messageObject({
      requestId: 'r1',
      model: 'm',
      content: '',
      toolCalls: [{ id: 'tu_1', type: 'function', function: { name: 'lookup', arguments: '{"q":1}' } }],
      finishReason: 'tool-calls',
      usage,
    });
    expect(body['content']).toEqual([{ type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 1 } }]);
    expect(body['stop_reason']).toBe('tool_use');
  });

  it('parses tool arguments back into an object', () => {
    const body = messageObject({
      requestId: 'r1',
      model: 'm',
      content: 'checking',
      toolCalls: [{ id: 'tu_1', type: 'function', function: { name: 'f', arguments: '{"a":[1,2]}' } }],
      finishReason: 'tool-calls',
      usage,
    });
    expect(body['content']).toEqual([
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'tu_1', name: 'f', input: { a: [1, 2] } },
    ]);
  });

  it('surfaces unparseable tool arguments instead of failing the response', () => {
    const body = messageObject({
      requestId: 'r1',
      model: 'm',
      content: '',
      toolCalls: [{ id: 'tu_1', type: 'function', function: { name: 'f', arguments: 'not json' } }],
      finishReason: 'tool-calls',
      usage,
    });
    expect(body['content']).toEqual([
      { type: 'tool_use', id: 'tu_1', name: 'f', input: { _raw: 'not json' } },
    ]);
  });
});

describe('createMessageFrames', () => {
  it('opens the text block lazily on the first delta', () => {
    const f = createMessageFrames({ requestId: 'r1', model: 'm' });
    const parsed = frames(f.textDelta('he'));
    expect(parsed.map((p) => p.event)).toEqual(['content_block_start', 'content_block_delta']);
    expect(parsed[0]?.data['index']).toBe(0);
  });

  it('opens the block only once across several deltas', () => {
    const f = createMessageFrames({ requestId: 'r1', model: 'm' });
    f.textDelta('he');
    expect(frames(f.textDelta('llo')).map((p) => p.event)).toEqual(['content_block_delta']);
  });

  it('numbers text and tool blocks contiguously and closes the text block first', () => {
    const f = createMessageFrames({ requestId: 'r1', model: 'm' });
    f.textDelta('thinking');
    const parsed = frames(f.toolCallStart('tu_1', 'lookup'));
    expect(parsed.map((p) => p.event)).toEqual(['content_block_stop', 'content_block_start']);
    expect(parsed[0]?.data['index']).toBe(0);
    expect(parsed[1]?.data['index']).toBe(1);
    expect(parsed[1]?.data['content_block']).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'lookup',
      input: {},
    });
  });

  it('emits no text block at all for a tool-only reply', () => {
    const f = createMessageFrames({ requestId: 'r1', model: 'm' });
    const parsed = frames(f.toolCallStart('tu_1', 'lookup'));
    expect(parsed.map((p) => p.event)).toEqual(['content_block_start']);
    expect(parsed[0]?.data['index']).toBe(0);
  });

  it('streams tool arguments as partial JSON', () => {
    const f = createMessageFrames({ requestId: 'r1', model: 'm' });
    f.toolCallStart('tu_1', 'lookup');
    const [frame] = frames(f.toolCallArgumentsDelta('{"q":'));
    expect(frame?.data['delta']).toEqual({ type: 'input_json_delta', partial_json: '{"q":' });
  });

  it('closes at most one block and is a no-op when none is open', () => {
    const f = createMessageFrames({ requestId: 'r1', model: 'm' });
    expect(f.closeBlock()).toBe('');
    f.textDelta('hi');
    expect(frames(f.closeBlock())[0]?.event).toBe('content_block_stop');
    expect(f.closeBlock()).toBe('');
  });

  it('carries the stop reason and output tokens on message_delta', () => {
    const f = createMessageFrames({ requestId: 'r1', model: 'm' });
    const [frame] = frames(f.delta({ finishReason: 'length', usage }));
    expect(frame?.event).toBe('message_delta');
    expect(frame?.data['delta']).toEqual({ stop_reason: 'max_tokens', stop_sequence: null });
    expect((frame?.data['usage'] as Record<string, number>)['output_tokens']).toBe(5);
  });

  it('starts with a usage stub so clients that read it do not see undefined', () => {
    const f = createMessageFrames({ requestId: 'r1', model: 'm' });
    const [frame] = frames(f.start());
    const message = frame?.data['message'] as Record<string, unknown>;
    expect(frame?.event).toBe('message_start');
    expect(message['usage']).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(message['id']).toBe('msg_r1');
  });

  it('reports a mid-stream failure in Anthropic’s error envelope', () => {
    const f = createMessageFrames({ requestId: 'r1', model: 'm' });
    const [frame] = frames(
      f.error({
        error: { message: 'boom', type: 'api_error', param: null, code: 'internal_error', request_id: 'r1' },
      }),
    );
    expect(frame?.event).toBe('error');
    expect(frame?.data['error']).toEqual({ type: 'api_error', message: 'boom' });
  });
});
