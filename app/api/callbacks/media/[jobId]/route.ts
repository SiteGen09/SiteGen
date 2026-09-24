import { randomUUID } from 'node:crypto';

import { resolvePlatformCreds } from '@/lib/admin/credentials';
import { isProvider } from '@/lib/ai/providers';
import { apiError } from '@/lib/api/errors';
import { applyRecord, callbackTokenMatches, loadJob } from '@/lib/media/jobs';
import { fetchImageTask } from '@/lib/media/kie';
import { logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';
import { z } from 'zod';

/**
 * The upstream's completion callback.
 *
 * Public by necessity — the provider cannot hold a credential for us — so the
 * per-job token in the query string is the only thing distinguishing a real
 * delivery from a forged one. It is compared in constant time.
 *
 * Note what this route does *not* do: it never believes the posted body. The
 * token proves the caller knows a secret tied to this job; it does not prove
 * the payload is honest. So the record is re-fetched from the provider and
 * that is what settles credits. A replayed or doctored delivery therefore
 * cannot mark a job succeeded or charge for an image that was never made.
 *
 * Always answers 200 to a well-formed delivery, including for work already
 * done: a provider that reads an error will retry, and the polling sweep
 * already covers anything genuinely missed.
 */

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId });

  const { jobId } = await context.params;
  const token = new URL(request.url).searchParams.get('token') ?? '';

  if (token.length === 0 || !(await callbackTokenMatches(jobId, token))) {
    log.warn('media_callback.rejected', { job_id: jobId });
    return apiError('unauthorized', 'invalid callback token', requestId, 401);
  }

  const job = await loadJob(jobId);
  if (job === null) {
    return apiError('not_found', 'no such media job', requestId, 404);
  }
  if (job.status === 'succeeded' || job.status === 'failed') {
    return Response.json({ ok: true, status: job.status });
  }
  if (job.upstreamTaskId === null) {
    // The enqueue has not returned yet; the sweep will pick this up.
    return Response.json({ ok: true, status: job.status });
  }

  try {
    const channel = await createServiceClient()
      .from('channels')
      .select('provider, base_url')
      .eq('id', job.channelId)
      .maybeSingle();
    const parsed = z
      .object({ provider: z.string(), base_url: z.string().nullable() })
      .safeParse(channel.data);
    if (!parsed.success || !isProvider(parsed.data.provider)) {
      return apiError('channel_unavailable', 'job channel is gone', requestId, 503);
    }

    const creds = await resolvePlatformCreds(parsed.data.provider, parsed.data.base_url);
    const record = await fetchImageTask(creds, job.upstreamTaskId);
    await applyRecord(job, record, log);

    log.info('media_callback.applied', { job_id: jobId, state: record.state });
    return Response.json({ ok: true, status: record.state });
  } catch (err) {
    log.error('media_callback.failed', {
      job_id: jobId,
      reason: err instanceof Error ? err.message : 'unknown error',
    });
    // 200 on purpose: the sweep will retry, and an error here only buys a
    // redelivery storm.
    return Response.json({ ok: true, status: 'deferred' });
  }
}
