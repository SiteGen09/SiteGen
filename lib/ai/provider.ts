import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

import type { Provider } from '@/lib/ai/providers';
import { kieChatFetch } from '@/lib/ai/kie-chat';

/** Logical unit of work a channel is asked to perform. */
export type TaskAlias = 'site.spec' | 'site.copy' | 'interview';

export interface ProviderCreds {
  provider: Provider;
  apiKey: string;
  baseUrl?: string | null;
}

/** Provider-agnostic model factory returned by {@link buildAI}. */
export interface AI {
  languageModel(modelId: string): LanguageModel;
}

/** Anthropic's fixed endpoint: the first-party client is built without a `baseURL`. */
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1';

function requireBaseUrl(creds: ProviderCreds): string {
  const baseUrl = creds.baseUrl?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error(`${creds.provider} provider requires a baseUrl`);
  }
  return baseUrl;
}

/**
 * Builds a model factory from decrypted channel credentials.
 *
 * Both Anthropic kinds go through the native provider rather than the
 * OpenAI-compatible shim, so prompt caching and Anthropic provider options
 * survive — over a custom gateway exactly as over the first party. The only
 * difference between them is where the request lands: `anthropic` is pinned to
 * Anthropic's own host, `anthropic_compatible` goes wherever the base URL
 * points. That is the whole reason they are separate kinds; a single kind that
 * sometimes honoured a base URL would make "which host holds this key" a
 * guess.
 */
export function buildAI(creds: ProviderCreds): AI {
  if (creds.provider === 'openai_images') {
    throw new Error('openai_images has no language model');
  }
  // Not an oversight: `kie_jobs` is an async job queue with no language-model
  // surface, so there is nothing to return. Throwing keeps it from falling
  // through to the OpenAI-compatible branch and posting chat completions at an
  // image endpoint. Image traffic goes through `lib/images/kie.ts` instead.
  if (creds.provider === 'kie_jobs') {
    throw new Error('kie_jobs is an async image job API and has no language model');
  }

  if (creds.provider === 'anthropic') {
    return createAnthropic({ apiKey: creds.apiKey });
  }

  const baseURL = requireBaseUrl(creds);

  if (creds.provider === 'anthropic_compatible') {
    return createAnthropic({ apiKey: creds.apiKey, baseURL });
  }

  // The Responses API is a different endpoint under the same base URL, not a
  // dialect of chat-completions: `/responses` takes `input` items where
  // `/chat/completions` takes `messages`. `@ai-sdk/openai-compatible` only
  // knows the latter, so this kind goes through the full OpenAI provider,
  // which is also what carries `reasoning.effort` and the built-in web-search
  // tool through as provider options.
  if (creds.provider === 'openai_responses') {
    const provider = createOpenAI({ apiKey: creds.apiKey, baseURL });
    return { languageModel: (modelId) => provider.responses(modelId) };
  }

  return createOpenAICompatible<string, string, string, string>({
    name: 'custom',
    apiKey: creds.apiKey,
    baseURL,
    includeUsage: true,
    fetch: new URL(baseURL).hostname === 'api.kie.ai' ? kieChatFetch : undefined,
  });
}

/**
 * Resolves the model a task runs on. Channel selection — and therefore
 * `modelId` — is decided upstream; this only binds it to the built provider.
 */
export function taskModel(ai: AI, task: TaskAlias, modelId: string): LanguageModel {
  return ai.languageModel(modelId);
}

/**
 * The endpoint a request built from these creds will actually reach.
 *
 * Lives beside {@link buildAI} because it restates that function's routing
 * rule: `anthropic` ignores `baseUrl` entirely. Surfacing the resolved
 * endpoint in the admin UI is what keeps a relay URL pasted against provider
 * `anthropic` from looking like it took effect — the mistake that
 * `anthropic_compatible` now gives a correct home.
 */
export function providerEndpoint(creds: ProviderCreds): string {
  if (creds.provider === 'anthropic') return ANTHROPIC_ENDPOINT;
  const baseUrl = creds.baseUrl?.trim();
  return baseUrl === undefined || baseUrl.length === 0 ? '(no base URL)' : baseUrl;
}
