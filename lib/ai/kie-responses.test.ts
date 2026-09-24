import { afterEach, describe, expect, it } from 'vitest';
import { generateText, streamText } from 'ai';

import { kieResponsesFetch, kieResponsesJson } from '@/lib/ai/kie-responses';
import { buildAI } from '@/lib/ai/provider';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sse(...frames: string[]): Response {
  return new Response(frames.join('\n\n') + '\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

const completed = {
  id: 'resp_123',
  object: 'response',
  status: 'completed',
  model: 'kimi-k3',
  output: [{
    type: 'message',
    role: 'assistant',
    id: 'm1',
    content: [{ type: 'output_text', text: 'ok', annotations: [] }],
  }],
  usage: { input_tokens: 2, output_tokens: 1 },
};

describe('kieResponsesJson', () => {
  it('extracts the completed Responses object from Kie SSE', async () => {
    const response = await kieResponsesJson(sse(
      'event: response.created\ndata: {"type": "response.created"}',
      'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: completed }),
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual(completed);
  });

  it('adds the SDK-required annotations array to Kie plain-text output', async () => {
    const responseWithoutAnnotations = {
      ...completed,
      output: [{
        type: 'message',
        role: 'assistant',
        id: 'm2',
        content: [{ type: 'output_text', text: 'ok' }],
      }],
    };
    const response = await kieResponsesJson(sse(
      'event: response.completed\ndata: ' + JSON.stringify({
        type: 'response.completed', response: responseWithoutAnnotations,
      }),
    ));

    expect(await response.json()).toMatchObject({
      output: [{ content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
    });
  });

  it('turns incomplete and failed events into errors instead of partial success', async () => {
    const incomplete = await kieResponsesJson(sse(
      'event: response.incomplete\ndata: ' + JSON.stringify({
        type: 'response.incomplete',
        response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      }),
    ));
    expect(incomplete.status).toBe(502);
    expect(await incomplete.json()).toMatchObject({
      error: { message: expect.stringContaining('max_output_tokens') },
    });

    const failed = await kieResponsesJson(sse(
      'event: response.failed\ndata: ' + JSON.stringify({
        type: 'response.failed', error: { message: 'upstream rejected request' },
      }),
    ));
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({
      error: { message: 'upstream rejected request' },
    });
  });

  it('rejects streams that end without a completed response', async () => {
    const response = await kieResponsesJson(sse('event: response.created\ndata: {"type":"response.created"}'));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining('without a completed response') },
    });
  });
});

describe('kieResponsesFetch', () => {
  it('buffers non-stream Kie SSE for the OpenAI SDK JSON path', async () => {
    globalThis.fetch = (async () => sse(
      'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: completed }),
    )) as typeof fetch;

    const response = await kieResponsesFetch('https://api.kie.ai/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-k3', input: 'say ok', stream: false }),
    });

    expect(await response.json()).toEqual(completed);
  });

  it('works through the Responses model for non-stream generateText', async () => {
    globalThis.fetch = (async () => sse(
      'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: completed }),
    )) as typeof fetch;

    const result = await generateText({
      model: buildAI({ provider: 'openai_responses', apiKey: 'test', baseUrl: 'https://api.kie.ai/codex/v1' })
        .languageModel('kimi-k3'),
      prompt: 'say ok',
      maxOutputTokens: 8,
      maxRetries: 0,
    });

    expect(result.text).toBe('ok');
    expect(result.usage.inputTokens).toBe(2);
    expect(result.usage.outputTokens).toBe(1);
  });

  it('keeps streaming incremental while normalizing SSE field spacing', async () => {
    globalThis.fetch = (async () => new Response(
      'event:response.created\ndata:{"type":"response.created"}\n\nevent:response.output_text.delta\ndata:{"delta":"ok"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )) as typeof fetch;

    const response = await kieResponsesFetch('https://api.kie.ai/codex/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-k3', input: 'say ok', stream: true }),
    });

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toBe(
      'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.output_text.delta\ndata: {"delta":"ok"}\n\n',
    );
  });

  it('streams Kie Responses through the OpenAI SDK', async () => {
    const frames = [
      'event: response.output_item.added\ndata: ' + JSON.stringify({
        type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' },
      }),
      'event: response.output_text.delta\ndata: ' + JSON.stringify({
        type: 'response.output_text.delta', item_id: 'm1', output_index: 0, delta: 'ok',
      }),
      'event: response.output_item.done\ndata: ' + JSON.stringify({
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] },
      }),
      'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: completed }),
    ];
    globalThis.fetch = (async () => sse(...frames)) as typeof fetch;

    const result = streamText({
      model: buildAI({ provider: 'openai_responses', apiKey: 'test', baseUrl: 'https://api.kie.ai/codex/v1' })
        .languageModel('kimi-k3'),
      prompt: 'say ok',
      maxOutputTokens: 8,
      maxRetries: 0,
    });

    expect(await result.text).toBe('ok');
  });

  it('leaves Kie JSON replies untouched', async () => {
    const jsonResponse = Response.json({ ok: true });
    globalThis.fetch = (async () => jsonResponse) as typeof fetch;
    const response = await kieResponsesFetch('https://api.kie.ai/codex/v1/responses', {
      method: 'POST', body: JSON.stringify({ stream: false }),
    });
    expect(response).toBe(jsonResponse);
  });
});
