import { admitGeneration } from '@/lib/guardrails/runtime';
import { randomUUID } from 'node:crypto';

import { authenticateApiKey, requireScope } from '@/lib/api/api-key-auth';
import { ApiError, apiError } from '@/lib/api/errors';
import { loadPlan } from '@/lib/chat/pipeline';
import { consumeRateLimit } from '@/lib/generate/ledger';
import {
  createMediaJob,
  loadJob,
  refreshMediaJob,
  signedUrlFor,
  SIGNED_URL_TTL_SECONDS,
  type MediaJob,
  type MediaKind,
} from '@/lib/media/jobs';
import { mediaRequestSchema } from '@/lib/media/request';
import { logger } from '@/lib/log';
import { mediaAvailability } from './availability';

/**
 * Shared handlers behind `/v1/images` and `/v1/videos`.
 *
 * The two endpoints exist because callers think in terms of "generate an
 * image" and "generate a video", not because the machinery differs — it does
 * not. Keeping one implementation is what stops the pair from drifting on
 * auth, billing or error shape, which is the same reason the three chat wire
 * formats share `lib/chat/pipeline.ts`.
 */

/** One scope covers both kinds: they are the same capability and the same unit. */
const SCOPE = 'media' as const;

/** Public JSON for one job. Never exposes the upstream URL or the channel. */
async function jobBody(job: MediaJob, requestId: string): Promise<Record<string, unknown>> {
  const url = job.status === 'succeeded' ? await signedUrlFor(job) : null;
  return {
    id: job.id,
    object: `${job.kind}.job`,
    kind: job.kind,
    status: job.status,
    model: job.publicModelId,
    created_at: job.createdAt,
    completed_at: job.completedAt,
    credits_charged: job.creditsCharged,
    ...(url === null ? {} : { url, url_expires_in: SIGNED_URL_TTL_SECONDS }),
    ...(job.errorCode === null
      ? {}
      : { error: { code: job.errorCode, message: job.errorMessage } }),
    request_id: requestId,
  };
}

/**
 * `POST /v1/images` and `POST /v1/videos` — enqueue a render.
 *
 * Asynchronous by necessity rather than by taste: the upstream takes a minute
 * or more, which outlives both the platform's function timeout and most HTTP
 * client defaults. So this returns a job id immediately and the caller polls,
 * mirroring the upstream's own shape.
 *
 * Credits are held here and settled only when the file lands, so a job that
 * never completes costs nothing.
 */
export async function handleCreate(request: Request, kind: MediaKind): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: `v1.${kind}s` });

  try {
    const auth = await authenticateApiKey(request.headers.get('authorization'), log);
    requireScope(auth, SCOPE);
    await admitGeneration(auth.ownerId);
    const limit = await consumeRateLimit(auth.apiKeyId, auth.rateLimitRpm);
    if (!limit.allowed) {
      const response = apiError('rate_limited', 'rate limit exceeded', requestId, 429);
      response.headers.set('Retry-After', String(limit.retryAfterSeconds));
      return response;
    }
    const availability = mediaAvailability(kind);
    if (!availability.enabled) {
      return apiError('channel_unavailable', availability.reason ?? 'media generation is unavailable', requestId, 503);
    }

    const parsed = mediaRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return apiError(
        'invalid_request',
        issue === undefined ? 'invalid request body' : `${issue.path.join('.')}: ${issue.message}`,
        requestId,
        400,
      );
    }

    const plan = await loadPlan(auth.ownerId);
    const job = await createMediaJob({
      userId: auth.ownerId,
      apiKeyId: auth.apiKeyId,
      publicModelId: parsed.data.model,
      kind,
      conversationId: null,
      input: parsed.data.input,
      planKey: plan.key,
      log,
    });

    log.info('media_job.created', { job_id: job.id, kind, model: job.publicModelId });

    // 202: accepted, not done. The Location header points at the poll route so
    // a caller need not construct it.
    return Response.json(await jobBody(job, requestId), {
      status: 202,
      headers: { location: `/v1/${kind}s/${job.id}` },
    });
  } catch (err) {
    if (err instanceof ApiError) {
      return apiError(err.code, err.message, requestId, err.status);
    }
    log.error('media_job.create_failed', {
      kind,
      reason: err instanceof Error ? err.message : 'unknown error',
    });
    return apiError('internal_error', `could not create the ${kind} job`, requestId, 500);
  }
}

/**
 * `GET /v1/images/{id}` and `GET /v1/videos/{id}` — poll one job.
 *
 * A finished job carries a signed, expiring URL minted per request rather than
 * a stored link: the bucket is private, so the file is only ever reachable
 * through a URL this route hands to the job's owner.
 *
 * A job belonging to another user, or of the other kind, is reported as
 * missing rather than forbidden, so job ids cannot be probed for existence.
 */
export async function handleRead(
  request: Request,
  id: string,
  kind: MediaKind,
): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: `v1.${kind}s.read` });

  try {
    const auth = await authenticateApiKey(request.headers.get('authorization'), log);
    requireScope(auth, SCOPE);

    const job = await loadJob(id);
    if (job === null || job.userId !== auth.ownerId || job.kind !== kind) {
      return apiError('not_found', `no such ${kind} job`, requestId, 404);
    }

    return Response.json(await jobBody(await refreshMediaJob(job, log), requestId));
  } catch (err) {
    if (err instanceof ApiError) {
      return apiError(err.code, err.message, requestId, err.status);
    }
    log.error('media_job.read_failed', {
      kind,
      reason: err instanceof Error ? err.message : 'unknown error',
    });
    return apiError('internal_error', `could not read the ${kind} job`, requestId, 500);
  }
}
