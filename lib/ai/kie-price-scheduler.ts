import { sql } from '@/lib/db';
import { logger } from '@/lib/log';

import { syncKiePrices } from './kie-price-sync';

const INTERVAL_MS = 60 * 60_000;
const globals = globalThis as typeof globalThis & { __kiePriceSync?: ReturnType<typeof setInterval> };

/**
 * Re-reads kie.ai's published prices every hour. Started once per server
 * process from instrumentation.ts; a second call (dev reloads) is a no-op, and
 * the sync's advisory lock keeps two processes from doubling up.
 */
export function startKiePriceSync(): void {
  if (globals.__kiePriceSync) return;
  const log = logger({ component: 'kie_prices' });
  const apiKey = process.env.KIE_API_KEY;
  if (!apiKey) {
    log.warn('kie_prices.disabled', { reason: 'KIE_API_KEY is not set' });
    return;
  }
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await syncKiePrices({ sql, apiKey, log });
    } catch {
      // Logged and recorded by syncKiePrices; the next hour retries.
    } finally {
      running = false;
    }
  };
  globals.__kiePriceSync = setInterval(() => void run(), INTERVAL_MS);
  globals.__kiePriceSync.unref?.();
  // First pass shortly after start, once the server has settled.
  setTimeout(() => void run(), 2 * 60_000).unref?.();
}
