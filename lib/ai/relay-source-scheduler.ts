import { sql } from '@/lib/db';
import { logger } from '@/lib/log';

import { syncRelaySources } from './relay-sources';

const INTERVAL_MS = 60_000;
/**
 * A run still pending after this is abandoned so the next tick can start a
 * fresh one. The database bounds its own side (see syncRelaySources), but a
 * silently dead socket can leave the client waiting for a reply indefinitely.
 */
const RUN_DEADLINE_MS = 2 * 60_000;
const globals = globalThis as typeof globalThis & { __relaySourceSync?: ReturnType<typeof setInterval> };

/**
 * Re-prices Relay chat channels every minute from the source selected in the
 * Relay account. Started once per server process from instrumentation.ts; a
 * second call (dev reloads) is a no-op. Without credentials nothing runs, and
 * routing withholds the channels whose price depends on the selection.
 */
export function startRelaySourceSync(): void {
  if (globals.__relaySourceSync) return;
  const log = logger({ component: 'relay_sources' });
  const token = process.env.RELAY_ACCESS_TOKEN;
  const userId = process.env.RELAY_USER_ID;
  if (!token || !userId) {
    log.warn('relay_sources.disabled', {
      reason: 'RELAY_ACCESS_TOKEN or RELAY_USER_ID is not set; Relay chat channels are withheld from routing',
    });
    return;
  }
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        syncRelaySources({ sql, token, userId, log }),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error('relay source sync exceeded its deadline')), RUN_DEADLINE_MS);
        }),
      ]);
    } catch (error) {
      // syncRelaySources logs and records its own failures; only the deadline is new here.
      if (error instanceof Error && error.message.includes('deadline')) {
        log.error('relay_sources.sync_stalled', { deadlineMs: RUN_DEADLINE_MS });
      }
    } finally {
      clearTimeout(deadline);
      running = false;
    }
  };
  void run();
  globals.__relaySourceSync = setInterval(() => void run(), INTERVAL_MS);
  globals.__relaySourceSync.unref?.();
}
