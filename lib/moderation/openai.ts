import { z } from 'zod';

import type { ModerationProvider, ModerationResult } from './index';

/** Upper bound on a moderation call, per the "must not take the API down" rule. */
const MODERATION_TIMEOUT_MS = 5_000;

/**
 * OpenAI's moderations endpoint. Overridable via `MODERATION_BASE_URL` so a
 * local stub can stand in for the real service during verification.
 */
function moderationsUrl(): string {
  const base = process.env.MODERATION_BASE_URL;
  if (base === undefined || base.length === 0) return 'https://api.openai.com/v1/moderations';
  return `${base.replace(/\/+$/, '')}/v1/moderations`;
}

/**
 * OpenAI's `/v1/moderations` response, narrowed to what a decision needs.
 * Parsed rather than trusted because it is an external payload.
 */
const responseSchema = z.object({
  results: z
    .array(
      z.object({
        flagged: z.boolean(),
        categories: z.record(z.string(), z.boolean()),
      }),
    )
    .min(1),
});

/**
 * Moderation backed by OpenAI's free `/v1/moderations` endpoint.
 *
 * Errors are the caller's to interpret: this throws on a non-2xx, a malformed
 * body, or a timeout so the route can apply its fail-open policy rather than
 * this module silently deciding to allow.
 */
export function openAiModeration(apiKey: string): ModerationProvider {
  return {
    async check(text: string): Promise<ModerationResult> {
      const response = await fetch(moderationsUrl(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'omni-moderation-latest', input: text }),
        signal: AbortSignal.timeout(MODERATION_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`moderation request failed: HTTP ${response.status}`);
      }

      const parsed = responseSchema.parse(await response.json());
      const result = parsed.results[0]!;
      const categories = Object.entries(result.categories)
        .filter(([, active]) => active)
        .map(([name]) => name)
        .sort();

      return { flagged: result.flagged, categories };
    },
  };
}