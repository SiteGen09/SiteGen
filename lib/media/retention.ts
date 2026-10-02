import { z } from 'zod';
import type { Logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Keeps generated media inside the storage allowance.
 *
 * Files (finished renders and checked reference copies) are deleted after
 * `MEDIA_RETENTION_DAYS` (7 by default). If the bucket still grows past
 * `MEDIA_STORAGE_BUDGET_MB` (800 by default, under the Supabase free plan's
 * 1 GB), the oldest files go first, even before their seven days are up.
 *
 * The job row is kept for billing and usage history, marked expired, and its
 * input (prompt and reference URLs) is cleared, so the database does not
 * accumulate prompts either.
 */

const BUCKET = 'generated-media';
const BATCH = 100;

function setting(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function retentionDays(): number {
  return setting('MEDIA_RETENTION_DAYS', 7);
}

/** When a job's file will be deleted at the latest. */
export function expiresAt(createdAt: string): string {
  return new Date(Date.parse(createdAt) + retentionDays() * 86_400_000).toISOString();
}

const candidateSchema = z.object({ name: z.string(), bytes: z.coerce.number(), reason: z.enum(['age', 'budget']) });

let lastRun = 0;

/**
 * Deletes expired files and marks their jobs. Throttled to once every ten
 * minutes, so the two-minute media sweep can call it every time.
 */
export async function expireOldMedia(log: Logger, force = false): Promise<{ deleted: number; bytes: number; expiredJobs: number }> {
  if (!force && Date.now() - lastRun < 10 * 60_000) return { deleted: 0, bytes: 0, expiredJobs: 0 };
  lastRun = Date.now();
  const service = createServiceClient();
  const cutoff = new Date(Date.now() - retentionDays() * 86_400_000).toISOString();
  const { data, error } = await service.rpc('media_retention_candidates', {
    p_cutoff: cutoff,
    p_budget_bytes: Math.round(setting('MEDIA_STORAGE_BUDGET_MB', 800) * 1024 * 1024),
    p_limit: 1000,
  });
  if (error !== null) throw new Error(`media retention lookup failed: ${error.message}`);
  const candidates = candidateSchema.array().parse(data ?? []);

  let deleted = 0;
  let bytes = 0;
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    const removed = await service.storage.from(BUCKET).remove(batch.map((candidate) => candidate.name));
    if (removed.error !== null) {
      log.error('media_retention.remove_failed', { reason: removed.error.message });
      break;
    }
    deleted += batch.length;
    bytes += batch.reduce((sum, candidate) => sum + candidate.bytes, 0);
    // Files deleted for the budget before their time: mark those jobs now.
    const early = batch.filter((candidate) => candidate.reason === 'budget').map((candidate) => candidate.name);
    if (early.length) {
      await service.from('media_jobs').update({ expired_at: new Date().toISOString(), input: {} })
        .in('storage_path', early).is('expired_at', null);
    }
  }

  // Every finished job past the cutoff: its file is gone (or never existed).
  const { data: expired, error: expireError } = await service.from('media_jobs')
    .update({ expired_at: new Date().toISOString(), input: {} })
    .lt('created_at', cutoff)
    .in('status', ['succeeded', 'failed'])
    .is('expired_at', null)
    .select('id');
  if (expireError !== null) log.error('media_retention.expire_failed', { reason: expireError.message });

  const result = { deleted, bytes, expiredJobs: expired?.length ?? 0 };
  if (deleted || result.expiredJobs) log.info('media_retention.done', result);
  return result;
}
