import { selectMediaChannel, type MediaChannelRow } from '@/lib/ai/channels';
import type { RoutingPreferences } from '@/lib/ai/sources';
import { GENSITE_MODEL_ID } from '@/lib/gensite/config';

/**
 * gensite-v1 for images and videos.
 *
 * As with chat, it is not a model of its own: a render is sent to the first
 * model in the list below that the caller's plan can reach, and the rest are
 * its fallbacks. It takes a prompt only, because every underlying model names
 * its extra options differently; a caller who needs reference images or
 * model-specific settings addresses that model directly.
 *
 * `GENSITE_IMAGE_MODELS` and `GENSITE_VIDEO_MODELS` (comma-separated public
 * model ids) replace the lists without a code change.
 */

const DEFAULT_MEDIA_MODELS: Record<'image' | 'video', readonly string[]> = {
  image: ['google/nano-banana', 'seedream/4.5-text-to-image', 'gpt-image-2', 'google/imagen4-fast'],
  video: ['bytedance/v1-pro-text-to-video', 'kling/v2-5-turbo-text-to-video-pro', 'grok-imagine/text-to-video', 'bytedance/v1-lite-text-to-video'],
};

export function gensiteMediaModels(kind: 'image' | 'video'): readonly string[] {
  const raw = process.env[kind === 'image' ? 'GENSITE_IMAGE_MODELS' : 'GENSITE_VIDEO_MODELS']?.trim();
  const configured = raw ? raw.split(',').map((id) => id.trim()).filter((id) => id !== '' && id !== GENSITE_MODEL_ID) : [];
  return configured.length ? configured : DEFAULT_MEDIA_MODELS[kind];
}

/**
 * The channel chain for a gensite-v1 render: the best reachable model's
 * channel first, then every other candidate's, in list order. Null when the
 * plan reaches none of them.
 */
export async function selectGensiteMediaChannel(
  kind: 'image' | 'video',
  planKey: string,
  preferences?: RoutingPreferences,
): Promise<MediaChannelRow | null> {
  const chains = await Promise.all(gensiteMediaModels(kind).map((model) =>
    selectMediaChannel(model, planKey, kind, preferences).catch(() => null)));
  const seen = new Set<string>();
  const ordered: MediaChannelRow[] = [];
  for (const channel of chains) {
    if (channel === null) continue;
    for (const candidate of [channel, ...(channel.fallbackChannels ?? [])]) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      ordered.push({ ...candidate, fallbackChannels: undefined });
    }
  }
  if (ordered.length === 0) return null;
  return { ...ordered[0]!, fallbackChannels: ordered.slice(1) };
}
