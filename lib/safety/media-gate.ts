import sharp from 'sharp';
import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { recordPolicyViolation } from '@/lib/guardrails/runtime';
import type { Logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';
import { classifyMedia, SafetyUnavailableError, type ScreenImage, type Verdict } from './media-classifier';
import { openAiModerationRule } from './openai-moderation';
import {
  MEDIA_POLICY_REQUIRED,
  MEDIA_REFUSAL,
  MEDIA_SAFETY_UNAVAILABLE,
  MEDIA_SUSPENDED,
} from './media-policy-text';
import { collectInput, downloadReference, rewriteInput, sha256, sniffKind, type UrlReference } from './media-references';
import { isSevere, screenMediaText, type MediaRule } from './media-rules';
import { extractVideoFrames, videoScreeningAvailable } from './video-frames';

/**
 * The safety gate every image and video request passes before a credit is
 * held or a provider is called, and every finished render passes before it is
 * stored or shown. It enforces the Acceptable Use Policy (/acceptable-use):
 *
 *   1. the account must have agreed to the policy and not be suspended;
 *   2. the word rules check every text field, in every normalised form;
 *   3. each reference is downloaded, checked to be what it claims, and shown
 *      to the classifier together with the text;
 *   4. references that pass are re-hosted, so the provider renders from the
 *      exact bytes that were checked;
 *   5. the finished output is classified again before it is kept.
 *
 * Any failure blocks the whole job. A refusal is logged with digests only and
 * counts toward a media suspension; a request involving minors suspends at once.
 */

const BUCKET = 'generated-media';
const MAX_REFERENCES = 8;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
/** Reference copies must outlive a queued render and any fallback resubmission. */
const REFERENCE_URL_TTL_SECONDS = 6 * 3600;
/** Images per classifier call; more are split into parallel calls. */
const IMAGES_PER_CALL = 10;

export type MediaStage = 'prompt' | 'reference' | 'output';

function setting(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function refusal(): ApiError {
  return new ApiError('content_policy_violation', MEDIA_REFUSAL, 400);
}

// ── Account access ──────────────────────────────────────────────────────────

const accessSchema = z.object({
  media_policy_accepted_at: z.string().nullable(),
  media_suspended_at: z.string().nullable(),
});

export interface MediaAccess {
  accepted: boolean;
  suspended: boolean;
}

export async function loadMediaAccess(userId: string): Promise<MediaAccess> {
  const { data, error } = await createServiceClient()
    .from('profiles')
    .select('media_policy_accepted_at, media_suspended_at')
    .eq('id', userId)
    .maybeSingle();
  if (error !== null || data === null) throw new ApiError('internal_error', 'could not check media access', 500);
  const row = accessSchema.parse(data);
  return { accepted: row.media_policy_accepted_at !== null, suspended: row.media_suspended_at !== null };
}

export async function assertMediaAccess(userId: string): Promise<void> {
  const access = await loadMediaAccess(userId);
  if (access.suspended) throw new ApiError('forbidden', MEDIA_SUSPENDED, 403);
  if (!access.accepted) throw new ApiError('forbidden', MEDIA_POLICY_REQUIRED, 403);
}

/** Records the account's agreement. Only the signed-in user can call the route that uses it. */
export async function acceptMediaPolicy(userId: string): Promise<void> {
  const { error } = await createServiceClient()
    .from('profiles')
    .update({ media_policy_accepted_at: new Date().toISOString() })
    .eq('id', userId)
    .is('media_policy_accepted_at', null);
  if (error !== null) throw new ApiError('internal_error', 'could not record the agreement', 500);
}

// ── Violations ──────────────────────────────────────────────────────────────

export interface ViolationRecord {
  userId: string;
  requestId: string;
  jobId?: string | null;
  stage: MediaStage;
  rule: MediaRule | 'unspecified';
  decidedBy: string;
  promptSha256?: string | null;
  referenceSha256?: readonly string[];
  log: Logger;
}

/**
 * Logs a refusal and applies the suspension rules. Never throws: bookkeeping
 * failing must not turn a refusal into a success.
 */
export async function recordMediaViolation(record: ViolationRecord): Promise<void> {
  const severe = isSevere(record.rule);
  record.log.warn('media_safety.refused', {
    user_id: record.userId, request_id: record.requestId, job_id: record.jobId ?? null,
    stage: record.stage, rule: record.rule, severe, decided_by: record.decidedBy,
  });
  try {
    const { data, error } = await createServiceClient().rpc('record_media_violation', {
      p_user: record.userId,
      p_request: record.requestId,
      p_job: record.jobId ?? null,
      p_stage: record.stage,
      p_rule: record.rule,
      p_severe: severe,
      p_prompt_sha256: record.promptSha256 ?? null,
      p_reference_sha256: [...(record.referenceSha256 ?? [])],
      p_decided_by: record.decidedBy,
      p_threshold: setting('MEDIA_VIOLATION_THRESHOLD', 3),
      p_window_days: setting('MEDIA_VIOLATION_WINDOW_DAYS', 30),
    });
    if (error !== null) throw new Error(error.message);
    const result = z.object({ suspended: z.boolean() }).safeParse(data);
    if (result.success && result.data.suspended) {
      record.log.error('media_safety.suspended', { alert: true, user_id: record.userId, rule: record.rule, severe });
    }
  } catch (err) {
    record.log.error('media_safety.record_failed', { alert: true, request_id: record.requestId, reason: err instanceof Error ? err.message : 'unknown' });
  }
  // Also feeds the account-wide strike count and generation cooldown.
  await recordPolicyViolation(`media/${record.rule}`, record.userId, record.requestId).catch(() => undefined);
}

// ── Images for the classifier ───────────────────────────────────────────────

/** A small JPEG of the image for the classifier; throws when it is not an image. */
export async function classifierImage(bytes: Uint8Array): Promise<ScreenImage> {
  const jpeg = await sharp(bytes, { failOn: 'error', limitInputPixels: 80_000_000 })
    .rotate()
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { bytes: jpeg, mediaType: 'image/jpeg' };
}

/**
 * The copy the provider is given: decoded and re-encoded, so only the pixels
 * that were checked survive. It drops metadata (including GPS) and every frame
 * of an animation after the first.
 */
async function rehostableImage(bytes: Uint8Array): Promise<{ bytes: Buffer; contentType: string; extension: string }> {
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: 80_000_000 }).rotate()
    .resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true });
  const { hasAlpha } = await image.metadata();
  return hasAlpha
    ? { bytes: await image.png().toBuffer(), contentType: 'image/png', extension: 'png' }
    : { bytes: await image.jpeg({ quality: 92 }).toBuffer(), contentType: 'image/jpeg', extension: 'jpg' };
}

/**
 * Both classifiers at once. Gemini must answer (it fails closed); OpenAI's
 * free moderation can only add a refusal.
 */
export async function classifyAll(input: { stage: 'request' | 'output'; kind: 'image' | 'video'; text: string; images: ScreenImage[]; log: Logger }): Promise<Verdict> {
  const groups: ScreenImage[][] = [];
  for (let i = 0; i < input.images.length; i += IMAGES_PER_CALL) groups.push(input.images.slice(i, i + IMAGES_PER_CALL));
  if (groups.length === 0) groups.push([]);
  const [verdicts, openAiRule] = await Promise.all([
    Promise.all(groups.map((images) => classifyMedia({ ...input, images }))),
    openAiModerationRule(input.text, input.images, input.log),
  ]);
  const blocks = verdicts.filter((verdict): verdict is Extract<Verdict, { verdict: 'block' }> => verdict.verdict === 'block');
  if (openAiRule !== null) blocks.push({ verdict: 'block', rule: openAiRule, model: 'openai-moderation' });
  if (blocks.length === 0) return verdicts[0]!;
  // The most serious finding decides: minors first, then any named rule over
  // a bare provider refusal.
  return blocks.find((block) => isSevere(block.rule)) ?? blocks.find((block) => block.rule !== 'unspecified') ?? blocks[0]!;
}

// ── Request screening ───────────────────────────────────────────────────────

interface LoadedReference {
  ref: UrlReference;
  sha256: string;
  screen: ScreenImage[];
  store: { bytes: Buffer; contentType: string; extension: string };
}

async function loadReference(ref: UrlReference): Promise<LoadedReference> {
  const downloaded = await downloadReference(ref.value, MAX_VIDEO_BYTES);
  const kind = sniffKind(downloaded.bytes);
  const digest = sha256(downloaded.bytes);
  if (kind === 'image') {
    if (downloaded.bytes.length > MAX_IMAGE_BYTES) throw new ApiError('invalid_request', 'a reference image is too large', 400);
    try {
      return { ref, sha256: digest, screen: [await classifierImage(downloaded.bytes)], store: await rehostableImage(downloaded.bytes) };
    } catch {
      throw new ApiError('invalid_request', 'a reference image could not be read', 400);
    }
  }
  if (kind === 'video') {
    if (!videoScreeningAvailable()) {
      throw new ApiError('invalid_request', 'reference videos cannot be safety-checked on this server yet', 400);
    }
    let frames: Buffer[];
    try {
      frames = await extractVideoFrames(downloaded.bytes, 8);
    } catch {
      throw new ApiError('invalid_request', 'a reference video could not be read', 400);
    }
    const webm = downloaded.bytes[0] === 0x1a;
    return {
      ref, sha256: digest,
      screen: await Promise.all(frames.map((frame) => classifierImage(frame))),
      store: { bytes: downloaded.bytes, contentType: webm ? 'video/webm' : 'video/mp4', extension: webm ? 'webm' : 'mp4' },
    };
  }
  throw new ApiError('invalid_request', 'only image and video references are supported', 400);
}

/** A task another job extends must be one of this user's finished renders. */
async function verifyTaskReferences(userId: string, tasks: readonly { value: string }[]): Promise<void> {
  if (tasks.length === 0) return;
  const ids = [...new Set(tasks.map((task) => task.value))];
  const { data, error } = await createServiceClient()
    .from('media_jobs')
    .select('upstream_task_id')
    .eq('user_id', userId)
    .eq('status', 'succeeded')
    .in('upstream_task_id', ids);
  if (error !== null) throw new ApiError('internal_error', 'could not check the referenced task', 500);
  const owned = new Set((data ?? []).map((row: { upstream_task_id: string }) => row.upstream_task_id));
  if (ids.some((id) => !owned.has(id))) {
    throw new ApiError('invalid_request', 'a referenced task is not one of your finished generations', 400);
  }
}

async function rehost(userId: string, requestId: string, loaded: readonly LoadedReference[]) {
  const storage = createServiceClient().storage.from(BUCKET);
  return Promise.all(loaded.map(async (reference, index) => {
    const path = `${userId}/references/${requestId}/${index}.${reference.store.extension}`;
    const upload = await storage.upload(path, reference.store.bytes, { contentType: reference.store.contentType, upsert: true });
    if (upload.error !== null) throw new ApiError('internal_error', 'could not store a checked reference', 500);
    const signed = await storage.createSignedUrl(path, REFERENCE_URL_TTL_SECONDS);
    if (signed.error !== null || signed.data === null) throw new ApiError('internal_error', 'could not store a checked reference', 500);
    return { path: reference.ref.path, value: signed.data.signedUrl };
  }));
}

export interface ScreenRequestInput {
  userId: string;
  requestId: string;
  kind: 'image' | 'video';
  input: Record<string, unknown>;
  /** gensite-v1 routes by prompt alone and takes no references. */
  promptOnly?: boolean;
  log: Logger;
}

/**
 * Screens one request. Returns the input to send upstream, with every
 * reference replaced by its checked copy; throws the refusal otherwise.
 */
export async function screenMediaRequest(request: ScreenRequestInput): Promise<Record<string, unknown>> {
  const { userId, requestId, kind, log } = request;
  await assertMediaAccess(userId);
  const collected = collectInput(request.input);
  const promptSha256 = sha256(collected.text);

  const hit = screenMediaText(collected.text);
  if (hit !== null) {
    await recordMediaViolation({ userId, requestId, stage: 'prompt', rule: hit.rule, decidedBy: 'rules', promptSha256, log });
    throw refusal();
  }

  if (request.promptOnly && (collected.urls.length > 0 || collected.tasks.length > 0)) {
    throw new ApiError('invalid_request', 'gensite-v1 takes a prompt only; choose a specific model to use reference files', 400);
  }
  if (collected.urls.length > MAX_REFERENCES) {
    throw new ApiError('invalid_request', `at most ${MAX_REFERENCES} reference files are allowed`, 400);
  }
  await verifyTaskReferences(userId, collected.tasks);
  const loaded = await Promise.all(collected.urls.map(loadReference));
  const referenceSha256 = loaded.map((reference) => reference.sha256);

  let verdict;
  try {
    verdict = await classifyAll({ stage: 'request', kind, text: collected.text, images: loaded.flatMap((reference) => reference.screen), log });
  } catch (err) {
    if (err instanceof SafetyUnavailableError) throw new ApiError('channel_unavailable', MEDIA_SAFETY_UNAVAILABLE, 503);
    throw err;
  }
  if (verdict.verdict === 'block') {
    await recordMediaViolation({
      userId, requestId, stage: loaded.length ? 'reference' : 'prompt', rule: verdict.rule,
      decidedBy: `classifier:${verdict.model}`, promptSha256, referenceSha256, log,
    });
    throw refusal();
  }

  log.info('media_safety.passed', { request_id: requestId, references: loaded.length, model: verdict.model });
  if (loaded.length === 0) return request.input;
  return rewriteInput(request.input, await rehost(userId, requestId, loaded));
}

// ── Output screening ────────────────────────────────────────────────────────

export interface OutputJob {
  id: string;
  userId: string;
  requestId: string;
  kind: 'image' | 'video';
}

export type OutputVerdict = 'allow' | 'block' | 'unreadable';

/**
 * Judges a finished render before it is stored. `block` has already been
 * recorded as a violation; the caller must discard the bytes and fail the job.
 * Throws `SafetyUnavailableError` so the caller can retry later instead.
 */
export async function screenMediaOutput(job: OutputJob, bytes: Uint8Array, log: Logger): Promise<OutputVerdict> {
  let images: ScreenImage[];
  try {
    images = job.kind === 'image'
      ? [await classifierImage(bytes)]
      : await Promise.all((await extractVideoFrames(bytes, 8)).map((frame) => classifierImage(frame)));
  } catch (err) {
    if (job.kind === 'video' && !videoScreeningAvailable()) throw new SafetyUnavailableError('video screening is not available');
    log.warn('media_safety.output_unreadable', { job_id: job.id, reason: err instanceof Error ? err.message : 'unknown' });
    return 'unreadable';
  }
  const { data } = await createServiceClient().from('media_jobs').select('input').eq('id', job.id).maybeSingle();
  const input = z.object({ input: z.record(z.string(), z.unknown()) }).safeParse(data);
  const text = input.success ? collectInput(input.data.input).text : '';
  const verdict = await classifyAll({ stage: 'output', kind: job.kind, text, images, log });
  if (verdict.verdict === 'allow') {
    log.info('media_safety.output_passed', { job_id: job.id, frames: images.length, model: verdict.model });
    return 'allow';
  }
  await recordMediaViolation({
    userId: job.userId, requestId: job.requestId, jobId: job.id, stage: 'output', rule: verdict.rule,
    decidedBy: `classifier:${verdict.model}`, promptSha256: text ? sha256(text) : null, log,
  });
  return 'block';
}
