/** Read-only route and provider smoke check for the requested current models. */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import { listPublicModels, selectChannelByModel } from '../lib/ai/channels';
import { resolvePlatformCreds } from '../lib/admin/credentials';
import { generateText } from 'ai';
import { buildAI } from '../lib/ai/provider';

const expected = [
  { modelId: 'gpt-6-sol', provider: 'openai_responses', baseUrl: 'https://api.kie.ai/codex/v1', routePrefix: 'kie-chat-' },
  { modelId: 'kimi-k3', provider: 'openai_responses', baseUrl: 'https://api.kie.ai/codex/v1', routePrefix: 'kie-chat-' },
  { modelId: 'deepseek-v4-1-flash', provider: 'openai_responses', baseUrl: 'https://api.kie.ai/codex/v1', routePrefix: 'kie-chat-' },
  { modelId: 'grok-4-7', provider: 'openai_responses', baseUrl: 'https://api.kie.ai/codex/v1', routePrefix: 'kie-chat-' },
  { modelId: 'claude-opus-5-5', provider: 'openai_compatible', baseUrl: 'https://relay.fast/v1', routePrefix: 'relay-' },
] as const;

const publicModels = new Set(await listPublicModels('free'));
for (const expectedModel of expected) {
  const { modelId, provider, baseUrl, routePrefix } = expectedModel;
  if (!publicModels.has(modelId)) throw new Error('Model missing from public Gensite list: ' + modelId);
  const channel = await selectChannelByModel(modelId, 'free');
  if (
    channel === null ||
    channel.provider !== provider ||
    channel.baseUrl !== baseUrl ||
    channel.modelId !== modelId ||
    !channel.id.startsWith(routePrefix)
  ) throw new Error('Gensite selected an unexpected provider route for ' + modelId);

  const startedAt = Date.now();
  try {
    const creds = await resolvePlatformCreds(provider, baseUrl);
    await generateText({
      model: buildAI(creds).languageModel(channel.modelId),
      prompt: 'Reply with the single word: ok',
      maxOutputTokens: 8,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
      const candidate = current as { cause?: unknown; issues?: unknown };
      if (Array.isArray(candidate.issues)) {
        const details = candidate.issues.map((issue) => {
          if (!issue || typeof issue !== 'object') return 'invalid response';
          const item = issue as { path?: unknown[]; message?: unknown };
          return (Array.isArray(item.path) ? item.path.join('.') : 'response') + ': ' +
            (typeof item.message === 'string' ? item.message : 'invalid response');
        });
        throw new Error('Gensite provider probe failed for ' + modelId + ': ' + details.join('; '));
      }
      current = candidate.cause;
    }
    throw new Error('Gensite provider probe failed for ' + modelId + ': ' +
      (error instanceof Error ? error.message : 'unknown provider error'));
  }
  console.log('PASS ' + modelId + ': listed, selected ' + channel.id + ', provider probe in ' + (Date.now() - startedAt) + ' ms');
}
