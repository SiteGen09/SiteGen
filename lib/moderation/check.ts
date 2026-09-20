import type { Logger } from '@/lib/log';

import type { ModerationResult } from './index';
import { getModerationProvider } from './provider';

/**
 * Runs the configured moderation provider and applies the gateway's fail-open
 * policy: a provider error or timeout allows the request but logs at error
 * level with `{alert: true}`, because a moderation outage must not take the API
 * down. A clean result is returned as-is for the route to act on.
 */
export async function checkContent(text: string, log: Logger): Promise<ModerationResult> {
  const provider = getModerationProvider(log);
  try {
    return await provider.check(text);
  } catch (err) {
    log.error('moderation.unavailable', {
      alert: true,
      detail: err instanceof Error ? err.message : String(err),
    });
    // Fail open: never block traffic because the moderation provider is down.
    return { flagged: false, categories: [] };
  }
}