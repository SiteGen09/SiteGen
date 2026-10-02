import { resolveChannel, selectChatRoute } from '@/lib/ai/channels';
import { MAX_CHAIN_DEPTH, type ChannelRow } from '@/lib/ai/fallback';
import { routingProviderIdentity } from '@/lib/ai/routing-provider';
import type { RoutingPreferences } from '@/lib/ai/sources';
import {
  isExcluded,
  routeExclusions,
  tierModels,
  type GensiteTier,
  type RouteExclusion,
} from '@/lib/gensite/config';
import { TIER_FALLBACKS } from '@/lib/gensite/router';

/** A gensite-v1 request's channel chain, across every candidate model of its tier. */
export interface GensiteRoute {
  /** The tier whose models actually made up the chain (a fallback tier if the chosen one had none). */
  tier: GensiteTier;
  start: ChannelRow;
  holdChannels: ChannelRow[];
  resolve: (id: string) => Promise<ChannelRow | null>;
  /** The public model a channel in this chain serves, for logs and the caller. */
  modelFor: (channelId: string) => string | undefined;
}

function allowed(channel: ChannelRow, model: string, exclusions: readonly RouteExclusion[]): boolean {
  if (exclusions.length === 0) return true;
  const identity = routingProviderIdentity({ baseUrl: channel.baseUrl, provider: channel.provider });
  // The upstream model id is checked as well as the public one, so a channel
  // publishing an excluded family under a different public name is caught too.
  return !isExcluded(exclusions, identity.id, model) && !isExcluded(exclusions, identity.id, channel.modelId);
}

/** A model's own Auto chain, flattened: its best channel, then its same-model siblings. */
async function modelChain(model: string, planKey: string, preferences: RoutingPreferences): Promise<ChannelRow[]> {
  const route = await selectChatRoute(model, planKey, preferences);
  if (route === null) return [];
  const siblings = await Promise.all((route.start.automaticFallbackIds ?? []).map((id) => route.resolve(id)));
  return [route.start, ...siblings.filter((row): row is ChannelRow => row !== null)];
}

/**
 * Builds the channel chain for a gensite-v1 request routed to `tier`.
 *
 * Every candidate model's chain is looked up at once, then laid end to end in
 * the tier's order, so the fallback walk moves from the best model's providers
 * to the next model's before giving up. Each link is marked automatic: a
 * provider that cannot serve right now (401/402/404) is skipped like an
 * outage, because the caller asked for gensite-v1, not for that provider.
 *
 * A tier with nothing servable hands over to its closest sibling tier.
 */
export async function selectGensiteRoute(
  tier: GensiteTier,
  planKey: string,
  preferences: RoutingPreferences,
): Promise<GensiteRoute | null> {
  const exclusions = routeExclusions();

  for (const candidateTier of [tier, ...TIER_FALLBACKS[tier]]) {
    const models = tierModels(candidateTier);
    const chains = await Promise.all(models.map((model) => modelChain(model, planKey, preferences)));

    const ordered: ChannelRow[] = [];
    const servedModel = new Map<string, string>();
    chains.forEach((chain, index) => {
      for (const channel of chain) {
        if (servedModel.has(channel.id) || !allowed(channel, models[index]!, exclusions)) continue;
        servedModel.set(channel.id, models[index]!);
        ordered.push({ ...channel, automaticRouting: true, automaticFallbackIds: [] });
      }
    });
    if (ordered.length === 0) continue;

    const byId = new Map(ordered.map((channel) => [channel.id, channel]));
    const start = { ...ordered[0]!, automaticFallbackIds: ordered.slice(1).map((channel) => channel.id) };
    return {
      tier: candidateTier,
      start,
      holdChannels: ordered.slice(0, MAX_CHAIN_DEPTH),
      resolve: async (id) => {
        const known = byId.get(id);
        if (known) return known;
        // An administrator's configured fallback link, still bound by the plan
        // and by the exclusion list.
        const configured = await resolveChannel(id, planKey);
        return configured && allowed(configured, configured.modelId, exclusions)
          ? { ...configured, automaticRouting: true }
          : null;
      },
      modelFor: (channelId) => servedModel.get(channelId),
    };
  }
  return null;
}
