import { randomUUID, timingSafeEqual } from 'node:crypto';

import { sweepOpenJobs } from '@/lib/media/jobs';
import { logger } from '@/lib/log';

/**
 * Polling backstop for media jobs.
 *
 * The callback is the fast path, but it cannot be the only one. It is undeliverable
 * in local development, where the upstream cannot reach localhost, and in production
 * any single delivery can be dropped. Without this sweep a dropped callback would
 * strand a hold until `reclaim_stranded_holds` expired it, which refunds the user but
 * also loses an image they paid for and that was actually generated.
 *
 * Safe to run alongside a callback for the same job: every transition in
 * `lib/images/jobs.ts` is guarded on a non-terminal status, so whichever arrives
 * second changes nothing.
 *
 * Authenticated with CRON_SECRET as a bearer token, matching the other crons.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Bounded so one run cannot exceed `maxDuration` on a large backlog. */
const SWEEP_LIMIT = 50;

function authorized(header: string | null, secret: string): boolean {
  if (header === null) return false;
  const expected = 'Bearer ' + secret;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header, 'utf8'), Buffer.from(expected, 'utf8'));
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 500 });
  try {
    if (!authorized(request.headers.get('authorization'), secret)) {
      return Response.json({ error: 'Invalid cron credentials' }, { status: 401 });
    }
  } catch {
    return Response.json({ error: 'Invalid cron credentials' }, { status: 401 });
  }

  const log = logger({ request_id: `cron:sweep-images:${randomUUID()}` });

  try {
    const result = await sweepOpenJobs(SWEEP_LIMIT, log);
    log.info('media_sweep.done', result);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    log.error('media_sweep.failed', {
      reason: err instanceof Error ? err.message : 'unknown error',
    });
    return Response.json({ error: 'sweep failed' }, { status: 500 });
  }
}
