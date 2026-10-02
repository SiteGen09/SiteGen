import { z } from 'zod';
import type { Logger } from '@/lib/log';
import type { ScreenImage } from './media-classifier';
import type { MediaRule } from './media-rules';

/**
 * OpenAI's free moderation endpoint, as a second, independent opinion.
 *
 * `omni-moderation-latest` reads text and images and costs nothing on any
 * tier, including free. It runs beside the Gemini classifier and can only add
 * refusals: if it is down or rate-limited the Gemini verdict stands, because
 * Gemini is the check that fails closed.
 *
 * Only categories that match the Acceptable Use Policy block. Plain
 * "violence" and "harassment" are left to the classifier, which can tell a
 * knight's battle from gore; the endpoint cannot.
 */

const BLOCKING: Record<string, MediaRule> = {
  'sexual/minors': 'minors',
  sexual: 'adult_sexual',
  hate: 'hate',
  'hate/threatening': 'hate',
  'harassment/threatening': 'hate',
  'violence/graphic': 'graphic_violence',
  'self-harm': 'self_harm',
  'self-harm/intent': 'self_harm',
  'self-harm/instructions': 'self_harm',
  'illicit/violent': 'illegal',
};
// Most specific first, so "sexual/minors" wins over "sexual".
const PRIORITY = Object.keys(BLOCKING);

const responseSchema = z.object({
  results: z.array(z.object({ categories: z.record(z.string(), z.boolean().nullable()) })).min(1),
});

export function openAiModerationKey(): string | null {
  for (const name of ['MODERATION_API_KEY', 'OPENAI_AI_KEY', 'OPENAI_API_KEY']) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** The policy rule a moderation result breaks, if any. */
export function blockingRule(categories: Record<string, boolean | null>): MediaRule | null {
  const hit = PRIORITY.find((category) => categories[category] === true);
  return hit === undefined ? null : BLOCKING[hit]!;
}

async function moderate(key: string, input: unknown): Promise<Record<string, boolean | null>> {
  const base = process.env.MODERATION_BASE_URL?.trim().replace(/\/+$/, '') || 'https://api.openai.com';
  const response = await fetch(`${base}/v1/moderations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'omni-moderation-latest', input }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`moderation HTTP ${response.status}`);
  return responseSchema.parse(await response.json()).results[0]!.categories;
}

/** At most this many images go to the endpoint per check (one per call). */
const MAX_IMAGES = 4;

/**
 * The rule the text or images break, or null when they pass or the endpoint
 * could not be asked. Never throws.
 */
export async function openAiModerationRule(text: string, images: readonly ScreenImage[], log: Logger): Promise<MediaRule | null> {
  const key = openAiModerationKey();
  if (key === null) return null;
  const snippet = text.slice(0, 8_000);
  // The endpoint takes one image per call; spread the sample across the set.
  const step = Math.max(1, Math.ceil(images.length / MAX_IMAGES));
  const sampled = images.filter((_, index) => index % step === 0).slice(0, MAX_IMAGES);
  const inputs: unknown[] = sampled.length
    ? sampled.map((image) => [
      ...(snippet ? [{ type: 'text', text: snippet }] : []),
      { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}` } },
    ])
    : snippet ? [snippet] : [];
  const results = await Promise.allSettled(inputs.map((input) => moderate(key, input)));
  for (const result of results) {
    if (result.status === 'rejected') {
      log.warn('media_safety.openai_moderation_failed', { reason: result.reason instanceof Error ? result.reason.message : 'unknown' });
      continue;
    }
    const rule = blockingRule(result.value);
    if (rule !== null) return rule;
  }
  return null;
}
