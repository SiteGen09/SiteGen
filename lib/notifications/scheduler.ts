import { sql } from '@/lib/db';
import { logger } from '@/lib/log';

import { runNotificationScan } from './scan';

const INTERVAL_MS = 5 * 60_000;
const globals = globalThis as typeof globalThis & { __notificationScan?: ReturnType<typeof setInterval> };

/**
 * Looks for notification-worthy events every five minutes. Started once per
 * server process from instrumentation.ts; a second call (dev reloads) is a
 * no-op, and the scan's advisory lock keeps two processes from doubling up.
 */
export function startNotificationScan(): void {
  if (globals.__notificationScan) return;
  const log = logger({ component: 'notifications' });
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runNotificationScan(sql, log);
    } finally {
      running = false;
    }
  };
  // Leave the first pass until the server has settled after a deploy.
  globals.__notificationScan = setInterval(() => void run(), INTERVAL_MS);
  globals.__notificationScan.unref?.();
  setTimeout(() => void run(), 30_000).unref?.();
}
