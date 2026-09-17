import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/** Logical unit of work a channel is asked to perform. */
export type TaskAlias = 'site.spec' | 'site.copy' | 'interview';

export interface ProviderCreds {
  provider: 'anthropic' | 'openai_compatible';
  apiKey: string;
  baseUrl?: string | null;
}

/** Provider-agnostic model factory returned by {@link buildAI}. */
export interface AI {
  languageModel(modelId: string): LanguageModel;
}

/**
 * Builds a model factory from decrypted channel credentials.
 *
 * Anthropic goes through the native provider rather than the OpenAI-compatible
 * shim so prompt caching and Anthropic provider options survive.
 */
export function buildAI(creds: ProviderCreds): AI {
  if (creds.provider === 'anthropic') {
    return createAnthropic({ apiKey: creds.apiKey });
  }

  const baseURL = creds.baseUrl?.trim();
  if (baseURL === undefined || baseURL.length === 0) {
    throw new Error('openai_compatible provider requires a baseUrl');
  }

  return createOpenAICompatible<string, string, string, string>({
    name: 'custom',
    apiKey: creds.apiKey,
    baseURL,
  });
}

/**
 * Resolves the model a task runs on. Channel selection — and therefore
 * `modelId` — is decided upstream; this only binds it to the built provider.
 */
export function taskModel(ai: AI, task: TaskAlias, modelId: string): LanguageModel {
  return ai.languageModel(modelId);
}
