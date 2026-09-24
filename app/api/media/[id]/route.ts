import { randomUUID } from 'node:crypto';

import { apiError } from '@/lib/api/errors';
import { loadJob, refreshMediaJob, signedUrlFor, SIGNED_URL_TTL_SECONDS } from '@/lib/media/jobs';
import { logger } from '@/lib/log';
import { createClient } from '@/lib/supabase/server';

/**
 * Session-authenticated poll for one media job, used by the chat workspace.
 *
 * Also what resolves a stored marker back into something renderable: the URL
 * is signed fresh on every call, so reopening a month-old conversation shows
 * the image rather than a dead link.
 */

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: 'dashboard.media.read' });

  try {
    const session = await createClient();
    const { data: userData, error: userError } = await session.auth.getUser();
    if (userError !== null || userData.user === null) {
      return apiError('unauthorized', 'sign in to view media', requestId, 401);
    }

    const { id } = await context.params;
    let job = await loadJob(id);
    if (job === null || job.userId !== userData.user.id) {
      return apiError('not_found', 'no such job', requestId, 404);
    }

    job = await refreshMediaJob(job, log);
    if (new URL(request.url).searchParams.get('download') === '1') {
      if (job.status !== 'succeeded') {
        return apiError('not_ready', 'this image is not ready to download', requestId, 409);
      }
      // Mint a fresh attachment URL so downloads work even after the preview URL expires.
      const downloadUrl = await signedUrlFor(job, true);
      if (downloadUrl === null) {
        return apiError('internal_error', 'could not download the image', requestId, 502);
      }
      return new Response(null, {
        status: 302,
        headers: { location: downloadUrl, 'cache-control': 'private, no-store' },
      });
    }
    const url = job.status === 'succeeded' ? await signedUrlFor(job) : null;
    return Response.json({
      id: job.id,
      kind: job.kind,
      status: job.status,
      created_at: job.createdAt,
      model: job.publicModelId,
      credits_charged: job.creditsCharged,
      ...(url === null ? {} : { url, url_expires_in: SIGNED_URL_TTL_SECONDS }),
      ...(job.errorCode === null
        ? {}
        : { error: { code: job.errorCode, message: job.errorMessage } }),
    });
  } catch (err) {
    log.error('media_job.dashboard_read_failed', {
      reason: err instanceof Error ? err.message : 'unknown error',
    });
    return apiError('internal_error', 'could not read the job', requestId, 500);
  }
}
