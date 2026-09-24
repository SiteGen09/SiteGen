import { generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChannelRow } from '@/lib/ai/fallback';
import { buildAI } from '@/lib/ai/provider';
import { costUsd, creditsForUsage } from '@/lib/ai/pricing';
import { streamChat, type ChatStreamHandle, type ChatStreamPart } from '@/lib/chat/stream';

const channel: ChannelRow = {
  id: 'kie-chat',
  provider: 'openai_compatible',
  baseUrl: 'https://api.kie.ai/v1',
  modelId: 'gemini-3-5-flash-openai',
  isByok: false,
  creditMultiplier: '1',
  status: 'active',
  fallbackTo: null,
  rates: { inputPerMTok: 1, outputPerMTok: 5, cachedPerMTok: 0.1 },
};

function event(value: unknown): string {
  return 'data: ' + JSON.stringify(value) + '\n\n';
}

const textEvent = (content = 'OK') =>
  event({ choices: [{ index: 0, delta: { role: 'assistant', content } }] });
const finishEvent = (reason: string) =>
  event({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageEvent = event({
  choices: [],
  credits_consumed: 0.01,
  usage: { prompt_tokens: 84, completion_tokens: 1, total_tokens: 213 },
});
const doneEvent = 'data: [DONE]\n\n';

// Matches the existing Kie capture: output, an empty choice frame, usage with
// an inconsistent total_tokens, then [DONE]. There is no finish_reason.
const capturedStream = textEvent() + event({ choices: [] }) + usageEvent + doneEvent;

function mockStream(sse: string, byteByByte = false) {
  const bytes = new TextEncoder().encode(sse);
  const mock = vi.fn<typeof fetch>(async () => {
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const end = byteByByte ? offset + 1 : bytes.length;
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream;charset=UTF-8' } });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function start(baseUrl = channel.baseUrl!) {
  return streamChat({
    start: { ...channel, baseUrl },
    resolve: async () => null,
    buildCreds: async () => ({ provider: channel.provider, baseUrl, apiKey: 'test-key' }),
    messages: [{ role: 'user', content: 'Reply with OK' }],
    maxOutputTokens: 64,
    tools: [{
      type: 'function',
      function: {
        name: 'weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }],
  });
}

async function collect(handle: ChatStreamHandle): Promise<ChatStreamPart[]> {
  const parts: ChatStreamPart[] = [];
  for await (const part of handle.partStream) parts.push(part);
  return parts;
}

async function expectFailure(sse: string, baseUrl?: string): Promise<void> {
  mockStream(sse);
  const handle = await start(baseUrl);
  // Billing observes completion independently of the response iterator. Both
  // must reject even when the SDK has already resolved usage and finishReason.
  const completion = expect(handle.completion).rejects.toBeDefined();
  await expect(collect(handle)).rejects.toBeDefined();
  await completion;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chat streaming through the real provider SDK', () => {
  it('Auto recovers from an unavailable provider before output and keeps the serving rates', async () => {
    const backup = { ...channel, id: 'relay-chat', baseUrl: 'https://relay.example/v1', creditMultiplier: '1.5', rates: { inputPerMTok: 2, outputPerMTok: 8, cachedPerMTok: .2 } };
    const request = vi.fn<typeof fetch>(async (url) => {
      if (String(url).startsWith(channel.baseUrl!)) return Response.json({ error: { message: 'unavailable' } }, { status: 503 });
      return new Response(textEvent('Backup reply') + finishEvent('stop') + usageEvent + doneEvent, { headers: { 'content-type': 'text/event-stream' } });
    });
    vi.stubGlobal('fetch', request);
    const handle = await streamChat({
      start: { ...channel, automaticRouting: true, automaticFallbackIds: [backup.id] },
      resolve: async (id) => id === backup.id ? backup : null,
      buildCreds: async (row) => ({ provider: row.provider, baseUrl: row.baseUrl, apiKey: 'test-key' }),
      messages: [{ role: 'user', content: 'Hello' }], maxOutputTokens: 64,
    });
    expect(await collect(handle)).toEqual([{ type: 'text', text: 'Backup reply' }]);
    expect((await handle.completion).usage.inputTokens).toBe(84);
    expect(handle.channel.id).toBe(backup.id);
    expect(handle.channel.rates).toEqual(backup.rates);
    expect(handle.channel.creditMultiplier).toBe('1.5');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('never replays a streamed request on a backup after output starts', async () => {
    const request = mockStream(textEvent('Partial reply') + event({ error: { message: 'upstream failed', code: 'upstream_error' } }) + doneEvent);
    const resolve = vi.fn(async () => ({ ...channel, id: 'backup' }));
    const handle = await streamChat({
      start: { ...channel, automaticRouting: true, automaticFallbackIds: ['backup'] }, resolve,
      buildCreds: async () => ({ provider: channel.provider, baseUrl: channel.baseUrl, apiKey: 'test-key' }),
      messages: [{ role: 'user', content: 'Hello' }], maxOutputTokens: 64,
    });
    const completed = expect(handle.completion).rejects.toBeDefined();
    await expect(collect(handle)).rejects.toBeDefined();
    await completed;
    expect(request).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('completes the captured Kie stream and retains its billable token counts', async () => {
    const request = mockStream(capturedStream);
    const handle = await start();
    expect(await collect(handle)).toEqual([{ type: 'text', text: 'OK' }]);
    const completed = await handle.completion;
    expect(completed.finishReason).toBe('stop');
    expect(completed.usage).toEqual({ inputTokens: 84, outputTokens: 1, cachedTokens: 0 });
    expect(creditsForUsage(costUsd(channel.rates, completed.usage), 1)).toBe(1);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('handles split UTF-8 bytes, CRLF, comments and multiline events without losing cached usage', async () => {
    const sse = ': heartbeat\n\n' + textEvent('café 😊') +
      'data: {"choices": [],\n' +
      'data: "usage": {"prompt_tokens":84,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":20}}}\n\n' +
      doneEvent;
    mockStream(sse.replaceAll('\n', '\r\n'), true);
    const handle = await start();
    expect(await collect(handle)).toEqual([{ type: 'text', text: 'café 😊' }]);
    expect((await handle.completion).usage).toEqual({
      inputTokens: 64, outputTokens: 5, cachedTokens: 20,
    });
  });

  it.each([['stop', 'stop'], ['length', 'length'], ['content_filter', 'content-filter']])(
    'preserves the upstream finish reason %s',
    async (upstream, expected) => {
      mockStream(textEvent() + finishEvent(upstream) + usageEvent + doneEvent);
      const handle = await start();
      await collect(handle);
      expect((await handle.completion).finishReason).toBe(expected);
    },
  );

  it('finishes a tool-only response as tool calls and forwards each argument fragment once', async () => {
    mockStream(event({ choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, id: 'call_1', function: { name: 'weather', arguments: '{"city":' },
    }] } }] }) + event({ choices: [{ index: 0, delta: { tool_calls: [{
      index: 0, function: { arguments: '"Paris"}' },
    }] } }] }) + usageEvent + doneEvent);
    const handle = await start();
    expect(await collect(handle)).toEqual([
      { type: 'tool-call-start', index: 0, id: 'call_1', name: 'weather' },
      { type: 'tool-call-delta', index: 0, arguments: '{"city":' },
      { type: 'tool-call-delta', index: 0, arguments: '"Paris"}' },
    ]);
    expect((await handle.completion).finishReason).toBe('tool-calls');
  });

  it('still accepts an explicitly completed empty response', async () => {
    mockStream(finishEvent('stop') + usageEvent + doneEvent);
    const handle = await start();
    expect(await collect(handle)).toEqual([]);
    expect((await handle.completion).finishReason).toBe('stop');
  });

  it('rejects EOF without a finish reason or a completed DONE event', async () => {
    await expectFailure(textEvent() + usageEvent);
    await expectFailure(textEvent() + usageEvent + 'data: [DONE]');
  });

  it('rejects a malformed event instead of treating DONE as recovery', async () => {
    await expectFailure(textEvent() + 'data: {broken\n\n' + usageEvent + doneEvent);
  });

  it.each(['', finishEvent('stop')])('rejects provider errors even with later completion %j', async (finish) => {
    await expectFailure(textEvent() + event({
      error: { message: 'upstream unavailable', type: 'server_error', code: 'upstream_error' },
    }) + finish + usageEvent + doneEvent);
  });

  it('does not turn an empty DONE-only response into a successful chat', async () => {
    mockStream(doneEvent);
    await expect(start()).rejects.toThrow('without a finish reason');
  });

  it('keeps a schema error a failure even when followed by DONE', async () => {
    await expectFailure(textEvent() + event({ choices: [{ delta: { content: 42 } }] }) + doneEvent);
  });

  it('does not relax validation for other compatible hosts', async () => {
    await expectFailure(capturedStream, 'https://relay.example/v1');
  });

  it('requests usage on ordinary compatible streams too', async () => {
    const request = mockStream(textEvent() + finishEvent('stop') + usageEvent + doneEvent);
    const handle = await start('https://relay.example/v1');
    await collect(handle);
    expect((await handle.completion).usage.inputTokens).toBe(84);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).stream_options).toEqual({
      include_usage: true,
    });
  });

  it('leaves non-streaming Kie responses usable by the SDK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 84, completion_tokens: 1 },
    })));
    const result = await generateText({
      model: buildAI({ provider: 'openai_compatible', baseUrl: channel.baseUrl, apiKey: 'test-key' })
        .languageModel(channel.modelId),
      prompt: 'Reply with OK',
      maxRetries: 0,
    });
    expect(result.text).toBe('OK');
    expect(result.usage.inputTokens).toBe(84);
  });
});
