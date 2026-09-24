import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';

// Byte-for-byte what api.kie.ai returned above.
const SSE = [
  'data: {"choices":[{"delta":{"content":"OK","role":"assistant"},"index":0}],"created":1789939090,"id":"a","object":"chat.completion.chunk"}',
  'data: {"choices":[],"created":1789939090,"id":"b","object":"chat.completion.chunk"}',
  'data: {"choices":[],"created":1789939090,"credits_consumed":0.01,"id":"c","object":"chat.completion.chunk","usage":{"completion_tokens":1,"completion_tokens_details":{"reasoning_tokens":0},"prompt_tokens":84,"total_tokens":213}}',
  'data: [DONE]',
].join('\n\n') + '\n\n';

const stubFetch = async () =>
  new Response(new TextEncoder().encode(SSE), {
    status: 200,
    headers: { 'content-type': 'text/event-stream;charset=UTF-8' },
  });

const provider = createOpenAICompatible({
  name: 'custom',
  apiKey: 'x',
  baseURL: 'https://example.invalid/v1',
  fetch: stubFetch as unknown as typeof fetch,
});

const result = streamText({
  model: provider.languageModel('gemini-3-5-flash-openai'),
  messages: [{ role: 'user', content: 'Reply with OK' }],
  maxOutputTokens: 64,
});

let text = '';
let streamError: unknown = null;
try {
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') text += part.text;
    if (part.type === 'error') { streamError = part.error; }
  }
} catch (err) {
  streamError = err;
}
console.log('text received:', JSON.stringify(text));
console.log('error part:', streamError instanceof Error ? streamError.name + ': ' + streamError.message : streamError);

for (const [name, p] of [['usage', result.usage], ['finishReason', result.finishReason]] as const) {
  try {
    console.log(name, '=>', JSON.stringify(await p));
  } catch (err) {
    console.log(name, '=> REJECTED:', err instanceof Error ? err.name + ': ' + err.message : err);
  }
}
