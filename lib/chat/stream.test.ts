import type { TextStreamPart, ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';
import { toChatParts, type ChatStreamPart } from './stream';

/** Hand-rolled part sources keep the mapping tests free of any provider. */
async function* parts(
  items: readonly TextStreamPart<ToolSet>[],
): AsyncGenerator<TextStreamPart<ToolSet>> {
  for (const item of items) yield item;
}

async function collect(source: AsyncIterable<ChatStreamPart>): Promise<ChatStreamPart[]> {
  const out: ChatStreamPart[] = [];
  for await (const part of source) out.push(part);
  return out;
}

function textDelta(text: string): TextStreamPart<ToolSet> {
  return { type: 'text-delta', id: 'msg-1', text };
}

function toolCall(toolCallId: string, toolName: string, input: unknown): TextStreamPart<ToolSet> {
  return { type: 'tool-call', toolCallId, toolName, input } as TextStreamPart<ToolSet>;
}

describe('toChatParts', () => {
  it('emits one start and each argument delta for a streamed tool call, without duplicating it', async () => {
    const result = await collect(
      toChatParts(
        parts([
          textDelta('thinking'),
          { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' },
          { type: 'tool-input-delta', id: 'call_1', delta: '{"city":' },
          textDelta(' more'),
          { type: 'tool-input-delta', id: 'call_1', delta: '"Paris"}' },
          { type: 'tool-input-end', id: 'call_1' },
          toolCall('call_1', 'get_weather', { city: 'Paris' }),
        ]),
      ),
    );

    expect(result).toEqual([
      { type: 'text', text: 'thinking' },
      { type: 'tool-call-start', index: 0, id: 'call_1', name: 'get_weather' },
      { type: 'tool-call-delta', index: 0, arguments: '{"city":' },
      { type: 'text', text: ' more' },
      { type: 'tool-call-delta', index: 0, arguments: '"Paris"}' },
    ]);
  });

  it('emits a whole tool call when the provider never streamed fragments', async () => {
    const result = await collect(toChatParts(parts([toolCall('call_9', 'search', { q: 'zod' })])));

    expect(result).toEqual([
      {
        type: 'tool-call',
        index: 0,
        id: 'call_9',
        name: 'search',
        arguments: '{"q":"zod"}',
      },
    ]);
  });

  it('stringifies empty arguments when the call carries no input', async () => {
    const result = await collect(toChatParts(parts([toolCall('call_0', 'ping', undefined)])));

    expect(result).toEqual([
      { type: 'tool-call', index: 0, id: 'call_0', name: 'ping', arguments: '{}' },
    ]);
  });

  it('indexes concurrent tool calls by first appearance and keeps deltas on the right index', async () => {
    const result = await collect(
      toChatParts(
        parts([
          { type: 'tool-input-start', id: 'call_a', toolName: 'first' },
          { type: 'tool-input-start', id: 'call_b', toolName: 'second' },
          { type: 'tool-input-delta', id: 'call_b', delta: 'b1' },
          { type: 'tool-input-delta', id: 'call_a', delta: 'a1' },
          { type: 'tool-input-delta', id: 'call_b', delta: 'b2' },
          toolCall('call_a', 'first', { a: 1 }),
          toolCall('call_b', 'second', { b: 2 }),
        ]),
      ),
    );

    expect(result).toEqual([
      { type: 'tool-call-start', index: 0, id: 'call_a', name: 'first' },
      { type: 'tool-call-start', index: 1, id: 'call_b', name: 'second' },
      { type: 'tool-call-delta', index: 1, arguments: 'b1' },
      { type: 'tool-call-delta', index: 0, arguments: 'a1' },
      { type: 'tool-call-delta', index: 1, arguments: 'b2' },
    ]);
  });

  it('throws the error carried by an error part', async () => {
    const boom = new Error('upstream died mid-stream');

    await expect(
      collect(toChatParts(parts([textDelta('hi'), { type: 'error', error: boom }]))),
    ).rejects.toBe(boom);
  });

  it('ignores lifecycle and unrelated parts', async () => {
    const result = await collect(
      toChatParts(
        parts([
          { type: 'start' },
          { type: 'text-start', id: 'msg-1' },
          textDelta('only this'),
          { type: 'text-end', id: 'msg-1' },
          { type: 'reasoning-delta', id: 'r-1', text: 'hidden' },
          { type: 'finish', finishReason: 'stop' } as TextStreamPart<ToolSet>,
        ]),
      ),
    );

    expect(result).toEqual([{ type: 'text', text: 'only this' }]);
  });
});
