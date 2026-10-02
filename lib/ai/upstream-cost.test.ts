import { afterEach, describe, expect, it } from 'vitest';
import { generateText, streamText } from 'ai';

import { billedCostUsd } from '@/lib/ai/pricing';
import { buildAI } from '@/lib/ai/provider';
import { createKieCostMeter } from '@/lib/ai/upstream-cost';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const sse = (...frames: string[]) =>
  new Response(frames.map((frame) => `data: ${frame}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });

const chatJson = {
  id: 'c1', object: 'chat.completion', created: 1, model: 'gemini-3-6-flash-openai',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 98 },
  credits_consumed: 0.01,
};

const completed = {
  id: 'resp_1', object: 'response', status: 'completed', model: 'deepseek-v4-1-flash',
  output: [{ type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
  usage: { input_tokens: 34, output_tokens: 15 },
};

describe('kie cost meter', () => {
  it('sums one figure per response and converts credits to USD', () => {
    const meter = createKieCostMeter();
    expect(meter.usd()).toBeUndefined();
    meter.addCredits(0.01);
    meter.addCredits(2);
    meter.addCredits(Number.NaN);
    expect(meter.usd()).toBe(0.01005);
  });

  it('captures credits_consumed from a kie chat JSON reply', async () => {
    globalThis.fetch = (async () => Response.json(chatJson)) as typeof fetch;
    const ai = buildAI({ provider: 'openai_compatible', apiKey: 't', baseUrl: 'https://api.kie.ai/v1' });
    const result = await generateText({ model: ai.languageModel('gemini-3-6-flash-openai'), prompt: 'ok', maxRetries: 0 });
    expect(result.text).toBe('ok');
    expect(ai.reportedCostUsd?.()).toBe(0.00005);
  });

  it('captures credits_consumed from the last chunk of a kie chat stream', async () => {
    globalThis.fetch = (async () => sse(
      JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] }),
      JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, choices: [], credits_consumed: 0.02, usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 98 } }),
    )) as typeof fetch;
    const ai = buildAI({ provider: 'openai_compatible', apiKey: 't', baseUrl: 'https://api.kie.ai/v1' });
    const result = streamText({ model: ai.languageModel('gemini-3-6-flash-openai'), prompt: 'ok', maxRetries: 0 });
    expect(await result.text).toBe('ok');
    await result.usage;
    expect(ai.reportedCostUsd?.()).toBe(0.0001);
  });

  it('captures credits_consumed from a kie Responses completed event', async () => {
    globalThis.fetch = (async () => new Response(
      'event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: completed, credits_consumed: 0.01 }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )) as typeof fetch;
    const ai = buildAI({ provider: 'openai_responses', apiKey: 't', baseUrl: 'https://api.kie.ai/codex/v1' });
    const result = await generateText({ model: ai.languageModel('deepseek-v4-1-flash'), prompt: 'ok', maxRetries: 0 });
    expect(result.text).toBe('ok');
    expect(ai.reportedCostUsd?.()).toBe(0.00005);
  });

  it('reports nothing for providers other than kie.ai', () => {
    expect(buildAI({ provider: 'openai_compatible', apiKey: 't', baseUrl: 'https://relay.fast/v1' }).reportedCostUsd).toBeUndefined();
  });
});

describe('billedCostUsd', () => {
  const rates = { inputPerMTok: 0.225, outputPerMTok: 1.125, cachedPerMTok: 0.225 };
  const usage = { inputTokens: 5, outputTokens: 1, cachedTokens: 0, totalTokens: 98 };

  it('uses the token estimate when nothing was reported', () => {
    expect(billedCostUsd(rates, usage)).toMatchObject({ source: 'tokens' });
  });

  it('uses the reported cost, including hidden reasoning and per-request minimums', () => {
    expect(billedCostUsd(rates, { ...usage, reportedCostUsd: 0.00005 })).toEqual({ costUsd: 0.00005, source: 'reported' });
  });

  it('uses a reported cost below the estimate, such as a cache discount', () => {
    const big = { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 };
    expect(billedCostUsd(rates, { ...big, reportedCostUsd: 0.1 })).toEqual({ costUsd: 0.1, source: 'reported' });
  });

  it('refuses a reported cost beyond what every token could cost', () => {
    const big = { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, totalTokens: 1_000_000 };
    const result = billedCostUsd(rates, { ...big, reportedCostUsd: 50 });
    expect(result.source).toBe('reported_implausible');
    expect(result.costUsd).toBeCloseTo(0.225, 10);
  });
});

describe('provider token totals', () => {
  it('keep kie.ai\'s hidden reasoning in the total that bounds a reported cost', async () => {
    const { normalizeUsage } = await import('@/lib/generate/usage');
    const usage = normalizeUsage(
      { inputTokens: 5, outputTokens: 1, totalTokens: 6, raw: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 30_006 } } as never,
      undefined,
    );
    expect(usage.totalTokens).toBe(30_006);
  });
});
