import { generateText } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { buildAI, providerEndpoint, type ProviderCreds } from '@/lib/ai/provider';
import { PROVIDER_ENDPOINT_PATH } from '@/lib/ai/providers';

/**
 * These assertions pin the rule the admin UI reports: `buildAI` builds the
 * Anthropic provider without a `baseURL`, so a base URL stored against
 * provider `anthropic` is inert. If that ever changes, this fails loudly
 * rather than letting the UI quietly report the wrong endpoint.
 */
describe('providerEndpoint', () => {
  it('reports the fixed Anthropic endpoint', () => {
    expect(providerEndpoint({ provider: 'anthropic', apiKey: 'k' })).toBe(
      'https://api.anthropic.com/v1',
    );
  });

  it('ignores a base URL set against anthropic, matching buildAI', () => {
    expect(
      providerEndpoint({ provider: 'anthropic', apiKey: 'k', baseUrl: 'https://relay.example/v1' }),
    ).toBe('https://api.anthropic.com/v1');
  });

  it('reports the base URL for openai_compatible', () => {
    expect(
      providerEndpoint({
        provider: 'openai_compatible',
        apiKey: 'k',
        baseUrl: '  https://relay.example/v1  ',
      }),
    ).toBe('https://relay.example/v1');
  });

  it('names the absence of a base URL rather than printing an empty string', () => {
    expect(providerEndpoint({ provider: 'openai_compatible', apiKey: 'k', baseUrl: null })).toBe(
      '(no base URL)',
    );
  });

  it('reports the gateway for anthropic_compatible, not Anthropic', () => {
    expect(
      providerEndpoint({
        provider: 'anthropic_compatible',
        apiKey: 'k',
        baseUrl: 'https://relay.example/v1',
      }),
    ).toBe('https://relay.example/v1');
  });
});

describe('buildAI', () => {
  it('builds every provider kind that carries what it needs', () => {
    expect(() => buildAI({ provider: 'anthropic', apiKey: 'k' })).not.toThrow();
    expect(() =>
      buildAI({ provider: 'anthropic_compatible', apiKey: 'k', baseUrl: 'https://relay/v1' }),
    ).not.toThrow();
    expect(() =>
      buildAI({ provider: 'openai_compatible', apiKey: 'k', baseUrl: 'https://relay/v1' }),
    ).not.toThrow();
    expect(() =>
      buildAI({ provider: 'openai_responses', apiKey: 'k', baseUrl: 'https://relay/v1' }),
    ).not.toThrow();
  });

  it('refuses a compatible provider with no gateway to call', () => {
    expect(() => buildAI({ provider: 'anthropic_compatible', apiKey: 'k' })).toThrow(
      /requires a baseUrl/,
    );
    expect(() => buildAI({ provider: 'openai_compatible', apiKey: 'k', baseUrl: '   ' })).toThrow(
      /requires a baseUrl/,
    );
    expect(() => buildAI({ provider: 'openai_responses', apiKey: 'k' })).toThrow(
      /requires a baseUrl/,
    );
  });
});

/**
 * The contract that matters: which URL each kind actually posts to. The map in
 * `PROVIDER_ENDPOINT_PATH` is what the credential forms promise the user, and
 * these assertions are what stop that promise from drifting away from the SDK
 * clients `buildAI` returns. Asserted through a live `generateText` call
 * against a stubbed `fetch` rather than by inspecting the client, because the
 * path is chosen inside the provider packages, not by us.
 */
describe('dispatch endpoints', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function urlFor(creds: ProviderCreds, body: unknown): Promise<string> {
    let seen = '';
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    await generateText({
      model: buildAI(creds).languageModel('some-model'),
      prompt: 'hi',
      maxRetries: 0,
    });
    return seen;
  }

  const anthropicBody = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'some-model',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  const chatBody = {
    id: 'cc_1',
    object: 'chat.completion',
    created: 0,
    model: 'some-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };

  const responsesBody = {
    id: 'resp_1',
    object: 'response',
    model: 'some-model',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        id: 'm1',
        status: 'completed',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  it('pins the first party to Anthropic, ignoring any stored base URL', async () => {
    const url = await urlFor(
      { provider: 'anthropic', apiKey: 'k', baseUrl: 'https://relay.example/v1' },
      anthropicBody,
    );
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('sends anthropic_compatible to the gateway', async () => {
    const url = await urlFor(
      { provider: 'anthropic_compatible', apiKey: 'k', baseUrl: 'https://relay.example/v1' },
      anthropicBody,
    );
    expect(url).toBe('https://relay.example/v1/messages');
  });

  it('sends openai_compatible to /chat/completions', async () => {
    const url = await urlFor(
      { provider: 'openai_compatible', apiKey: 'k', baseUrl: 'https://relay.example/v1' },
      chatBody,
    );
    expect(url).toBe('https://relay.example/v1/chat/completions');
  });

  /** A Responses-only gateway — kie.ai's /codex/v1 — is unreachable any other way. */
  it('sends openai_responses to /responses', async () => {
    const url = await urlFor(
      { provider: 'openai_responses', apiKey: 'k', baseUrl: 'https://api.kie.ai/codex/v1' },
      responsesBody,
    );
    expect(url).toBe('https://api.kie.ai/codex/v1/responses');
  });

  /**
   * `kie_jobs` is excluded because it has no language model to build: it is an
   * async job queue, dispatched by `lib/images/kie.ts`. Its entry in the path
   * map exists for the credential forms only, and the assertion below pins
   * that `buildAI` refuses it rather than falling through to a chat client.
   */
  it('refuses to build a language model for the image job kind', () => {
    expect(() =>
      buildAI({ provider: 'kie_jobs', apiKey: 'k', baseUrl: 'https://api.kie.ai/api/v1' }),
    ).toThrow(/no language model/);
  });

  it('agrees with the path the credential forms advertise', async () => {
    for (const [provider, path] of Object.entries(PROVIDER_ENDPOINT_PATH)) {
      if (provider === 'kie_jobs' || provider === 'openai_images') continue;
      expect(
        await urlFor(
          { provider: provider as ProviderCreds['provider'], apiKey: 'k', baseUrl: 'https://relay.example/v1' },
          provider === 'openai_responses'
            ? responsesBody
            : provider === 'openai_compatible'
              ? chatBody
              : anthropicBody,
        ),
      ).toMatch(new RegExp(`${path.replace(/\//g, '\/')}$`));
    }
  });
});
