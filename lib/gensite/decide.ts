import { resolvePlatformCreds } from '@/lib/admin/credentials';
import { selectChatRoute } from '@/lib/ai/channels';
import type { RoutingPreferences } from '@/lib/ai/sources';
import type { ChatMessage, ChatTool } from '@/lib/chat/request';
import type { ReasoningEffort } from '@/lib/chat/reasoning';
import { classifierSettings, type GensiteTier } from '@/lib/gensite/config';
import { classifyDifficulty, type ClassifyResult } from '@/lib/gensite/classify';
import { selectGensiteRoute, type GensiteRoute } from '@/lib/gensite/route';
import { decideRoute, DIFFICULTY_TIER, extractFeatures, latestUserText } from '@/lib/gensite/router';

export interface GensiteRouting {
  route: GensiteRoute | null;
  /** The tier chosen for the request, before any fallback to a sibling tier. */
  tier: GensiteTier;
  /** Present when the rules were unsure and the classifier was asked. */
  classification?: ClassifyResult;
}

/**
 * Chooses a gensite-v1 request's tier and channel chain: the routing rules
 * first, then, only when they cannot tell how hard the request is and the
 * classifier is enabled, a small model's verdict.
 *
 * While the classifier thinks, the chains for all three verdicts are looked
 * up, so asking it costs its reply time and nothing more. If it fails or runs
 * out of time, the rules' safe default stands.
 */
export async function routeGensite(input: {
  messages: readonly ChatMessage[];
  tools?: readonly ChatTool[] | undefined;
  reasoning?: ReasoningEffort | undefined;
  planKey: string;
  preferences: RoutingPreferences;
}): Promise<GensiteRouting> {
  const decision = decideRoute(extractFeatures(input));
  const lookup = (tier: GensiteTier) => selectGensiteRoute(tier, input.planKey, input.preferences);
  const settings = classifierSettings();
  if (!decision.classify || !settings.enabled) return { route: await lookup(decision.tier), tier: decision.tier };

  const candidates = new Map<GensiteTier, Promise<GensiteRoute | null>>(
    Object.values(DIFFICULTY_TIER).map((tier) => [tier, lookup(tier)]),
  );
  // Settled even when unused, so an abandoned lookup can never surface as an unhandled rejection.
  for (const pending of candidates.values()) void pending.catch(() => null);

  const classifierRoute = await selectChatRoute(settings.model, input.planKey, input.preferences).catch(() => null);
  const classification: ClassifyResult = classifierRoute === null
    ? { difficulty: null, latencyMs: 0, failure: 'classifier model unavailable' }
    : await classifyDifficulty({
      text: latestUserText(input.messages),
      channel: classifierRoute.start,
      buildCreds: (channel) => resolvePlatformCreds(channel.provider, channel.baseUrl),
      timeoutMs: settings.timeoutMs,
    });

  const tier = classification.difficulty === null ? decision.tier : DIFFICULTY_TIER[classification.difficulty];
  const route = (await candidates.get(tier)) ?? (await lookup(decision.tier));
  return { route, tier, classification };
}
