import type { Logger } from '@/lib/log';

import { ALLOW_ALL, type ModerationProvider } from './index';
import { openAiModeration } from './openai';

/**
 * Resolves the moderation provider from `MODERATION_API_KEY`.
 *
 * When the key is unset the gateway allows traffic (moderation is a filter, not
 * a gate the whole API depends on) and warns once per process so the gap is
 * visible in logs without spamming every request.
 */
let warnedMissingKey = false;

export function getModerationProvider(log?: Logger): ModerationProvider {
  const apiKey = process.env.MODERATION_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      log?.warn('moderation.key_missing', {
        detail: 'MODERATION_API_KEY is not set; content moderation is disabled',
      });
    }
    return ALLOW_ALL;
  }
  return openAiModeration(apiKey);
}

/** Test seam: lets the once-per-process warning be re-armed between cases. */
export function resetModerationWarning(): void {
  warnedMissingKey = false;
}