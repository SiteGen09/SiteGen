import { enforceLocalPolicy, observePolicyRejection, recordPolicyViolation, generationRequestId } from '@/lib/guardrails/runtime';
import { isPolicyRejection, policyText } from '@/lib/guardrails/policy';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';
import { after } from 'next/server';
import { generateRelayImage, prepareRelayImage, relayImageResultSchema, type RelayImageResult } from '@/lib/media/relay';

import { selectMediaChannel } from '@/lib/ai/channels';
import { MEDIA_UPSTREAM_USD_PER_CREDIT, creditsForUsage } from '@/lib/ai/pricing';
import { loadRoutingPreferences } from '@/lib/ai/sources';
import { isProvider } from '@/lib/ai/providers';
import { resolvePlatformCreds } from '@/lib/admin/credentials';
import { ApiError } from '@/lib/api/errors';
import { holdCredits, releaseCredits, settleCredits } from '@/lib/generate/ledger';
import { createImageTask, fetchImageTask, type UpstreamRecord } from '@/lib/media/kie';
import { MediaSubmissionError, submitWithFallback } from '@/lib/media/fallback';
import type { Logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

export { mediaMarker, parseMediaMarker } from '@/lib/media/marker';

/**
 * Lifecycle of a media job — image or video: hold, enqueue, then settle or
 * release when the result lands.
 *
 * The two kinds share every step. They differ only in how long the upstream
 * takes, how large the result is, and the file extension it lands under, none
 * of which is worth a second pipeline.
 *
 * The billing shape is why this cannot live in the chat pipeline. There the
 * hold and the settle are microseconds apart inside one request; here they are
 * separated by a minute or more and by a process boundary, because the result
 * arrives on a callback. Every transition therefore has to be safe to run
 * twice — a callback and the polling sweep routinely race — which is what the
 * status guards on each update enforce.
 */

const BUCKET = 'generated-media';

/** How long a download of the upstream's temporary file may take. */
const FETCH_TIMEOUT_MS = 60_000;

/** Lifetime of a signed result URL: long enough to download, short enough to expire. */
export const SIGNED_URL_TTL_SECONDS = 3600;

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type MediaKind = 'image' | 'video';

export interface MediaJob {
  id: string;
  userId: string;
  requestId: string;
  channelId: string;
  publicModelId: string;
  kind: MediaKind;
  conversationId: string | null;
  upstreamTaskId: string | null;
  status: JobStatus;
  storagePath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  creditMultiplier: string;
  creditsHeld: number;
  creditsCharged: number | null;
  createdAt: string;
  completedAt: string | null;
}

const jobRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  request_id: z.string(),
  channel_id: z.string(),
  public_model_id: z.string(),
  kind: z.enum(['image', 'video']),
  conversation_id: z.string().nullable(),
  upstream_task_id: z.string().nullable(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  storage_path: z.string().nullable(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  credit_multiplier: z.union([z.string(), z.number()]).transform(String),
  credits_held: z.coerce.number(),
  credits_charged: z.coerce.number().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

const JOB_COLUMNS =
  'id, user_id, request_id, channel_id, public_model_id, kind, conversation_id, upstream_task_id, status, storage_path, error_code, error_message, credit_multiplier, credits_held, credits_charged, created_at, completed_at';

function toJob(row: z.infer<typeof jobRowSchema>): MediaJob {
  return {
    id: row.id,
    userId: row.user_id,
    requestId: row.request_id,
    channelId: row.channel_id,
    publicModelId: row.public_model_id,
    kind: row.kind,
    conversationId: row.conversation_id,
    upstreamTaskId: row.upstream_task_id,
    status: row.status,
    storagePath: row.storage_path,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    creditMultiplier: row.credit_multiplier,
    creditsHeld: row.credits_held,
    creditsCharged: row.credits_charged,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

/**
 * The URL the upstream posts the finished record to.
 *
 * Null when no publicly reachable origin is configured, which is the normal
 * state in local development: the upstream cannot reach localhost, so the job
 * is closed by the polling sweep instead. Returning null rather than a
 * localhost URL keeps the upstream from retrying a delivery that can never
 * succeed.
 */
export function callbackUrlFor(jobId: string, token: string): string | null {
  const origin = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, '');
  if (origin === undefined || origin.length === 0) return null;
  if (origin.startsWith('http://localhost') || origin.startsWith('http://127.')) return null;
  return `${origin}/api/callbacks/media/${jobId}?token=${encodeURIComponent(token)}`;
}

export interface CreateJobInput {
  userId: string;
  apiKeyId: string | null;
  publicModelId: string;
  kind: MediaKind;
  /** Set when the job was started from a dashboard conversation. */
  conversationId: string | null;
  input: Record<string, unknown>;
  planKey: string;
  log: Logger;
}

/**
 * Holds credits, records the job, then enqueues it upstream.
 *
 * The row is written before the upstream call so a task id can never exist
 * without a job to attach it to — the reverse order would leak a paid
 * generation with nothing to settle against. If the enqueue then fails, the
 * hold is released and the job marked failed in the same pass.
 */
export async function createMediaJob(input: CreateJobInput): Promise<MediaJob> {
  await enforceLocalPolicy(policyText(input.input));
  const preferences = await loadRoutingPreferences(input.userId);
  const channel = await selectMediaChannel(
    input.publicModelId,
    input.planKey,
    input.kind,
    preferences,
  );
  if (channel === null) {
    throw new ApiError(
      'model_not_found',
      `unknown ${input.kind} model '${input.publicModelId}'`,
      404,
    );
  }

  const candidates = [channel, ...(channel.fallbackChannels ?? [])].flatMap((candidate, index) => {
    try {
      const relay = candidate.provider === 'openai_images' ? prepareRelayImage(candidate, input.input) : null;
      return [{ channel: candidate, relay, credits: creditsForUsage(relay?.costUsd ?? candidate.requestPriceUsd, Number(candidate.creditMultiplier)) }];
    } catch (error) {
      // A fallback with incompatible image options cannot serve this request.
      if (index === 0) throw error;
      return [];
    }
  });
  const credits = candidates[0]!.credits;
  const reserved = Math.max(...candidates.map((candidate) => candidate.credits));
  const requestId = generationRequestId() ?? randomUUID();
  const hold = await holdCredits(input.userId, requestId, reserved, channel.id);
  if (!hold.success) {
    throw new ApiError(
      'insufficient_credits',
      `not enough credits: ${reserved} required, ${hold.balance ?? 0} available`,
      402,
    );
  }

  const callbackToken = randomUUID();
  const service = createServiceClient();
  const { data, error } = await service
    .from('media_jobs')
    .insert({
      user_id: input.userId,
      api_key_id: input.apiKeyId,
      request_id: requestId,
      channel_id: channel.id,
      public_model_id: input.publicModelId,
      kind: input.kind,
      conversation_id: input.conversationId,
      input: input.input,
      callback_token: callbackToken,
      credit_multiplier: channel.creditMultiplier,
      credits_held: credits,
    })
    .select(JOB_COLUMNS)
    .single();

  if (error !== null) {
    await releaseCredits(requestId);
    throw new ApiError('internal_error', 'could not record the image job', 500);
  }

  let job = toJob(jobRowSchema.parse(data));
  async function failed(err: unknown) {
    await observePolicyRejection(err);
    const saved = await service.from('media_jobs').select('provider_result').eq('id', job.id).single();
    if (saved.data?.provider_result) {
      input.log.warn('relay.storage_retry', { job_id: job.id });
      return;
    }
    await failJob(job.id, requestId, 'enqueue_failed', errorText(err), input.log);
  }

  async function submit(from: number, background: boolean): Promise<MediaJob> {
    return submitWithFallback(candidates.slice(from), async (candidate, offset) => {
      const { channel: serving, relay, credits: servingCredits } = candidate;
      let creds;
      try { creds = await resolvePlatformCreds(serving.provider, serving.baseUrl); } catch (error) {
        if (error instanceof ApiError && error.code === 'channel_unavailable') {
          throw new MediaSubmissionError('provider credentials are unavailable', 503);
        }
        throw error;
      }
      const upstreamTaskId = relay ? 'relay:' + job.id : null;
      const prepared = await service.from('media_jobs').update({
        channel_id: serving.id, credit_multiplier: serving.creditMultiplier,
        credits_held: servingCredits, upstream_task_id: upstreamTaskId,
        status: relay ? 'running' : 'queued', updated_at: new Date().toISOString(),
      }).eq('id', job.id).in('status', ['queued', 'running']).select('id');
      if (prepared.error) throw new ApiError('internal_error', 'could not prepare media provider', 500);
      if (!prepared.data?.length) throw new ApiError('generation_failed', 'media job has already closed', 409);
      job = { ...job, channelId: serving.id, creditMultiplier: serving.creditMultiplier, creditsHeld: servingCredits, upstreamTaskId, status: relay ? 'running' : 'queued' };
      if (relay && !background) {
        // Keep image work alive after returning the job. Remaining candidates
        // are tried only on an explicit refusal before any image is generated.
        after(async () => {
          try { await submit(from + offset, true); } catch (error) { await failed(error); }
        });
        return job;
      }
      if (relay) {
        const result = await generateRelayImage(creds, serving.modelId, relay.input);
        const saved = await service.from('media_jobs').update({ provider_result: result, updated_at: new Date().toISOString() }).eq('id', job.id).in('status', ['queued', 'running']);
        if (saved.error) throw new Error('could not save image result');
        await finishRelayImage(job, result, input.log);
        return { ...job, status: 'succeeded' };
      }
      const taskId = await createImageTask(creds, serving.modelId, input.input, callbackUrlFor(job.id, callbackToken));
      // Once a task ID exists, this request must never be sent to a backup.
      const running = await service.from('media_jobs').update({ upstream_task_id: taskId, status: 'running', updated_at: new Date().toISOString() }).eq('id', job.id).in('status', ['queued', 'running']);
      if (running.error) input.log.error('media_job.task_id_write_failed', { job_id: job.id });
      job = { ...job, upstreamTaskId: taskId, status: 'running' };
      return job;
    });
  }

  try { return await submit(0, false); } catch (err) {
    await failed(err);
    throw err;
  }
}

/**
 * Marks a job failed and returns its hold.
 *
 * Guarded on a non-terminal status so a callback and the polling sweep cannot
 * both release the same hold: `release_credits` is keyed on the request id, so
 * a second call would otherwise refund twice.
 */
export async function failJob(
  jobId: string,
  requestId: string,
  code: string,
  message: string,
  log: Logger,
): Promise<void> {
  const service = createServiceClient();
  const { data } = await service
    .from('media_jobs')
    .update({
      status: 'failed',
      error_code: code,
      error_message: message.slice(0, 500),
      credits_charged: 0,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .in('status', ['queued', 'running'])
    .select('id');

  // No row updated means something else closed this job first; releasing again
  // would refund twice.
  if ((data ?? []).length === 0) return;

  await recordMediaUsageEvent(jobId, 'failed', 0, log);

  try {
    await releaseCredits(requestId);
  } catch (err) {
    log.error('media_job.release_failed', { job_id: jobId, reason: errorText(err) });
  }
}

/**
 * Copies the finished image into storage, then settles the hold.
 *
 * The download and upload both happen before any status change, so a network
 * or storage failure leaves the job open for the sweep to retry rather than
 * marking it succeeded with no image — which `image_jobs_succeeded_has_image`
 * would reject anyway.
 */
export async function succeedJob(
  job: MediaJob,
  record: UpstreamRecord,
  log: Logger,
): Promise<void> {
  if (record.imageUrl === null) {
    await failJob(job.id, job.requestId, 'malformed_result', 'no image URL returned', log);
    return;
  }

  let bytes: ArrayBuffer;
  let contentType: string;
  try {
    const response = await fetch(record.imageUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    contentType = response.headers.get('content-type') ?? 'image/png';
    bytes = await response.arrayBuffer();
  } catch (err) {
    // Left open on purpose: the upstream file may simply not be served yet.
    log.warn('media_job.download_failed', { job_id: job.id, reason: errorText(err) });
    return;
  }

  const extension = extensionFor(job.kind, contentType, record.imageUrl);
  const path = `${job.userId}/${job.id}.${extension}`;
  const service = createServiceClient();
  const { error: uploadError } = await service.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (uploadError !== null) {
    log.warn('media_job.upload_failed', { job_id: job.id, reason: uploadError.message });
    return;
  }

  const charged = chargeFor(job, record, log);
  const { data } = await service
    .from('media_jobs')
    .update({
      status: 'succeeded',
      storage_path: path,
      upstream_url: record.imageUrl,
      credits_charged: charged,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', job.id)
    .in('status', ['queued', 'running'])
    .select('id');

  if ((data ?? []).length === 0) return;

  await recordMediaUsageEvent(job.id, 'ok', charged, log);

  try {
    // Use the serving provider's actual charge and release the remaining hold.
    await settleCredits(job.requestId, charged, {
      kind: job.kind,
      job_id: job.id,
      model: job.publicModelId,
      upstream_credits: record.upstreamCredits,
    });
  } catch (err) {
    log.error('media_job.settle_failed', { job_id: job.id, reason: errorText(err) });
  }
}


/** Records one terminal media outcome in the existing analytics table. */
async function recordMediaUsageEvent(
  jobId: string,
  status: 'ok' | 'failed',
  creditsCharged: number,
  log: Logger,
): Promise<void> {
  const service = createServiceClient();
  const { data: row, error: loadError } = await service
    .from('media_jobs')
    .select('user_id, api_key_id, request_id, channel_id, public_model_id, kind, created_at, completed_at, credits_charged')
    .eq('id', jobId)
    .maybeSingle();
  if (loadError !== null || row === null) {
    log.error('media_usage.load_failed', { job_id: jobId, db_error: loadError?.code ?? 'missing' });
    return;
  }
  const completedAt = row.completed_at === null ? Date.now() : Date.parse(row.completed_at);
  const createdAt = Date.parse(row.created_at);
  const latencyMs = Number.isFinite(completedAt) && Number.isFinite(createdAt)
    ? Math.max(0, Math.round(completedAt - createdAt))
    : null;
  const { error } = await service.from('usage_events').upsert({
    request_id: row.request_id,
    user_id: row.user_id,
    api_key_id: row.api_key_id,
    channel_id: row.channel_id,
    source_label: row.kind + ' - ' + row.public_model_id,
    input_tokens: null,
    output_tokens: null,
    cached_tokens: null,
    latency_ms: latencyMs,
    status,
    cost_usd: null,
    credits_charged: row.credits_charged ?? creditsCharged,
    created_at: row.completed_at ?? row.created_at,
  });
  if (error !== null) log.error('media_usage.write_failed', { job_id: jobId, db_error: error.code });
}
/**
 * Credits to charge for a finished job.
 *
 * The upstream reports what it actually consumed, so a four-second video is
 * not billed as a ten-second one. That is the whole reason this is a true-up
 * rather than a flat charge: `request_price_usd` cannot know the duration or
 * resolution the caller asked for, only the model they asked it of.
 *
 * Capped at the hold. Settlement releases the hold and charges the actual
 * amount, so an actual above the estimate would take the balance below what
 * the caller agreed to reserve. When that happens the estimate is wrong and
 * the log says so — the channel's price is too low and wants raising.
 */
function chargeFor(job: MediaJob, record: UpstreamRecord, log: Logger): number {
  if (record.upstreamCredits === null) return job.creditsHeld;
  const actual = creditsForUsage(
    record.upstreamCredits * MEDIA_UPSTREAM_USD_PER_CREDIT,
    Number(job.creditMultiplier),
  );
  if (actual > job.creditsHeld) {
    log.warn('media_job.estimate_too_low', {
      job_id: job.id,
      model: job.publicModelId,
      held: job.creditsHeld,
      actual,
    });
    return job.creditsHeld;
  }
  return actual;
}

/**
 * File extension for the stored object.
 *
 * Taken from the content type where possible and from the upstream URL
 * otherwise, because some hosts serve video as `application/octet-stream`. The
 * extension is what makes a browser play the file rather than download it, so
 * guessing `.png` for a video is a visible bug, not a cosmetic one.
 */
export function extensionFor(kind: MediaKind, contentType: string, url: string): string {
  const fromType = contentType.toLowerCase();
  if (kind === 'video') {
    if (fromType.includes('webm')) return 'webm';
    if (fromType.includes('quicktime')) return 'mov';
    if (fromType.includes('mp4')) return 'mp4';
    const fromUrl = /\.(mp4|webm|mov)(?:[?#]|$)/i.exec(url);
    return fromUrl === null ? 'mp4' : fromUrl[1]!.toLowerCase();
  }
  if (fromType.includes('jpeg') || fromType.includes('jpg')) return 'jpg';
  if (fromType.includes('webp')) return 'webp';
  return 'png';
}

/** Applies one upstream record to a job. Safe to call repeatedly. */
export async function applyRecord(
  job: MediaJob,
  record: UpstreamRecord,
  log: Logger,
): Promise<void> {
  if (record.state === 'succeeded') {
    await succeedJob(job, record, log);
    return;
  }
  if (record.state === 'failed') {
    if (isPolicyRejection({ code: record.errorCode, message: record.errorMessage })) {
      await recordPolicyViolation('provider/content-policy', job.userId, job.requestId);
    }
    await failJob(
      job.id,
      job.requestId,
      record.errorCode ?? 'upstream_failed',
      record.errorMessage ?? 'the provider failed to generate the image',
      log,
    );
  }
}

export async function loadJob(jobId: string): Promise<MediaJob | null> {
  const { data, error } = await createServiceClient()
    .from('media_jobs')
    .select(JOB_COLUMNS)
    .eq('id', jobId)
    .maybeSingle();
  if (error !== null) throw new ApiError('internal_error', 'could not load the job', 500);
  return data === null ? null : toJob(jobRowSchema.parse(data));
}

/**
 * Constant-time check of a callback's token.
 *
 * The callback route is public — the upstream cannot authenticate to it — so
 * this token is the only thing separating a real delivery from a forged one.
 */
export async function callbackTokenMatches(jobId: string, presented: string): Promise<boolean> {
  const { data } = await createServiceClient()
    .from('media_jobs')
    .select('callback_token')
    .eq('id', jobId)
    .maybeSingle();
  const expected = z.object({ callback_token: z.string() }).safeParse(data);
  if (!expected.success) return false;

  const a = Buffer.from(expected.data.callback_token);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A signed, expiring URL for a finished job's file. */
export async function signedUrlFor(job: MediaJob, download = false): Promise<string | null> {
  if (job.storagePath === null) return null;
  const { data, error } = await createServiceClient()
    .storage.from(BUCKET)
    .createSignedUrl(job.storagePath, SIGNED_URL_TTL_SECONDS, {
      download: download ? `generated-${job.storagePath.split('/').at(-1)}` : undefined,
    });
  return error === null && data !== null ? data.signedUrl : null;
}

/**
 * Refresh an authorized job from its provider, including when callbacks cannot
 * reach localhost. A transient provider/storage failure leaves it retryable.
 * Callers must verify ownership before invoking this function.
 */
export async function refreshMediaJob(job: MediaJob, log: Logger): Promise<MediaJob> {
  if (job.status === 'succeeded' || job.status === 'failed' || job.upstreamTaskId === null) {
    return job;
  }

  try {
    const service = createServiceClient();
    const channel = await service
      .from('channels')
      .select('provider, base_url')
      .eq('id', job.channelId)
      .maybeSingle();
    const parsed = z
      .object({ provider: z.string(), base_url: z.string().nullable() })
      .safeParse(channel.data);
    if (!parsed.success || !isProvider(parsed.data.provider)) return job;

    if (parsed.data.provider === 'openai_images') {
      const stored = await service.from('media_jobs').select('provider_result').eq('id', job.id).single();
      const result = relayImageResultSchema.safeParse(stored.data?.provider_result);
      if (result.success) {
        await finishRelayImage(job, result.data, log);
      } else if (Date.now() - Date.parse(job.createdAt) > 10 * 60_000) {
        await failJob(job.id, job.requestId, 'render_timeout', 'Image generation timed out', log);
      } else {
        return job;
      }
    } else {
      const creds = await resolvePlatformCreds(parsed.data.provider, parsed.data.base_url);
      const record = await fetchImageTask(creds, job.upstreamTaskId);
      if (record.state === 'running') return job;
      await applyRecord(job, record, log);
    }

    return (await loadJob(job.id)) ?? job;
  } catch (err) {
    log.warn('media_job.refresh_failed', { job_id: job.id, reason: errorText(err) });
    return job;
  }
}

/**
 * The polling backstop. Reconciles jobs the callback never closed — every job
 * in local development, where no public URL exists, and in production whenever
 * a delivery is dropped.
 */
export async function sweepOpenJobs(
  limit: number,
  log: Logger,
): Promise<{ checked: number; closed: number }> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('media_jobs')
    .select(JOB_COLUMNS)
    .in('status', ['queued', 'running'])
    .not('upstream_task_id', 'is', null)
    .order('updated_at', { ascending: true })
    .limit(limit);
  if (error !== null) throw new ApiError('internal_error', 'could not list open jobs', 500);

  const jobs = jobRowSchema
    .array()
    .parse(data ?? [])
    .map(toJob);
  let closed = 0;

  for (const job of jobs) {
    const refreshed = await refreshMediaJob(job, log);
    if (refreshed.status === 'succeeded' || refreshed.status === 'failed') closed += 1;
  }

  return { checked: jobs.length, closed };
}

/** Relay-only settlement; Kie continues using its existing lifecycle. */
async function finishRelayImage(job: MediaJob, result: RelayImageResult, log: Logger): Promise<void> {
  const bytes = Buffer.from(result.data[0]!.b64_json, 'base64');
  if (bytes.length < 8 || bytes.length > 30 * 1024 * 1024) throw new Error('Invalid image size');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216;
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('Unsupported image format');
  const extension = png ? 'png' : jpeg ? 'jpg' : 'webp';
  const contentType = png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp';
  const storagePath = `${job.userId}/${job.id}.${extension}`;
  const service = createServiceClient();
  const upload = await service.storage.from(BUCKET).upload(storagePath, bytes, { contentType, upsert: true });
  if (upload.error) throw new Error('Image storage failed');
  const finished = await service.rpc('finish_relay_image', { p_job_id: job.id, p_storage_path: storagePath });
  if (finished.error) throw new Error('Could not finish image job');
  await recordMediaUsageEvent(job.id, 'ok', job.creditsHeld, log);
}
