import { z } from 'zod';
import { isPolicyRejection } from '@/lib/guardrails/policy';

import { ApiError } from '@/lib/api/errors';
import { MediaSubmissionError } from '@/lib/media/fallback';
import type { ProviderCreds } from '@/lib/ai/provider';

/**
 * Client for kie.ai's asynchronous job API — the upstream behind image
 * channels (`provider = 'kie_jobs'`).
 *
 * Server-only: it carries a decrypted key. Nothing here is an AI SDK provider,
 * because the shape is a queue rather than a model: `createTask` returns a
 * task id in milliseconds and the image appears roughly ninety seconds later,
 * announced by callback or found by polling.
 *
 * Every response is wrapped in an envelope that returns HTTP 200 even for
 * application errors, with the real outcome in `code`. Treating a non-200
 * `code` as a failure is therefore mandatory, not defensive.
 */

const CREATE_TIMEOUT_MS = 20_000;
const RECORD_TIMEOUT_MS = 15_000;

const envelopeSchema = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.unknown().nullable().optional(),
});

const createDataSchema = z.object({ taskId: z.string().min(1) });

/**
 * `resultJson` is JSON encoded inside a JSON string, and is empty until the
 * job finishes. Parsed defensively: a malformed body from a job that reports
 * success must surface as a failed job, never as a job with no image.
 */
const resultJsonSchema = z.object({ resultUrls: z.array(z.string().url()).min(1) });

const recordDataSchema = z.object({
  taskId: z.string(),
  state: z.string(),
  successFlag: z.number().nullable().optional(),
  resultJson: z.string().nullable().optional(),
  failCode: z.union([z.string(), z.number()]).nullable().optional(),
  failMsg: z.string().nullable().optional(),
  costTime: z.number().nullable().optional(),
  creditsConsumed: z.number().nullable().optional(),
});

/** Normalized job state. `running` covers every non-terminal upstream state. */
export type UpstreamState = 'running' | 'succeeded' | 'failed';

export interface UpstreamRecord {
  taskId: string;
  state: UpstreamState;
  /** Temporary upstream URL; durable only once copied into storage. */
  imageUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  upstreamCredits: number | null;
}

function baseOf(creds: ProviderCreds): string {
  const baseUrl = creds.baseUrl?.trim().replace(/\/+$/, '');
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new ApiError('channel_unavailable', 'kie_jobs channel has no base URL', 503);
  }
  return baseUrl;
}

async function call(
  url: string,
  apiKey: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new ApiError('channel_unavailable', `image provider unreachable: ${reason}`, 502);
  }

  const parsed = envelopeSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('generation_failed', 'image provider returned an unreadable body', 502);
  }
  if (!response.ok || parsed.data.code !== 200) {
    if (isPolicyRejection({ message: parsed.data.msg })) {
      throw new ApiError('content_policy_violation', 'the provider rejected this request under its content policy', 400);
    }
    // A task ID means the job may already exist. Never automatically submit it
    // again, even if an inconsistent error envelope accompanies that ID.
    const accepted = createDataSchema.safeParse(parsed.data.data).success;
    if (!accepted) throw new MediaSubmissionError(
      `image provider rejected the request: ${parsed.data.msg ?? parsed.data.code}`,
      response.ok ? parsed.data.code : response.status,
    );
    throw new ApiError(
      'generation_failed',
      `image provider rejected the request: ${parsed.data.msg ?? parsed.data.code}`,
      502,
    );
  }
  return parsed.data.data;
}

/**
 * Enqueues a generation and returns the upstream task id.
 *
 * `callbackUrl` is passed straight through; the upstream posts the finished
 * record to it. It is optional because local development has no publicly
 * reachable URL, and the polling sweep covers that case.
 */
export async function createImageTask(
  creds: ProviderCreds,
  model: string,
  input: Record<string, unknown>,
  callbackUrl: string | null,
): Promise<string> {
  const data = await call(
    `${baseOf(creds)}/jobs/createTask`,
    creds.apiKey,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        input,
        ...(callbackUrl === null ? {} : { callBackUrl: callbackUrl }),
      }),
    },
    CREATE_TIMEOUT_MS,
  );

  const parsed = createDataSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError('generation_failed', 'image provider returned no task id', 502);
  }
  return parsed.data.taskId;
}

/** Normalizes one upstream record, whatever stage it is at. */
export function toUpstreamRecord(data: unknown): UpstreamRecord {
  const parsed = recordDataSchema.safeParse(data);
  if (!parsed.success) {
    throw new ApiError('generation_failed', 'image provider returned an unreadable record', 502);
  }
  const row = parsed.data;
  const failCode = row.failCode === null || row.failCode === undefined ? null : String(row.failCode);

  if (row.state === 'success' || row.successFlag === 1) {
    const result = resultJsonSchema.safeParse(
      ((): unknown => {
        try {
          return JSON.parse(row.resultJson ?? '');
        } catch {
          return null;
        }
      })(),
    );
    // A success with no usable URL is a failure: reporting it as succeeded
    // would settle credits for an image the caller can never fetch.
    return result.success
      ? {
          taskId: row.taskId,
          state: 'succeeded',
          imageUrl: result.data.resultUrls[0]!,
          errorCode: null,
          errorMessage: null,
          upstreamCredits: row.creditsConsumed ?? null,
        }
      : {
          taskId: row.taskId,
          state: 'failed',
          imageUrl: null,
          errorCode: 'malformed_result',
          errorMessage: 'the provider reported success but returned no image URL',
          upstreamCredits: row.creditsConsumed ?? null,
        };
  }

  if (row.state === 'fail' || row.successFlag === 2 || row.successFlag === 3) {
    return {
      taskId: row.taskId,
      state: 'failed',
      imageUrl: null,
      errorCode: failCode ?? 'upstream_failed',
      errorMessage: row.failMsg ?? 'the provider failed to generate the image',
      upstreamCredits: row.creditsConsumed ?? null,
    };
  }

  return {
    taskId: row.taskId,
    state: 'running',
    imageUrl: null,
    errorCode: null,
    errorMessage: null,
    upstreamCredits: row.creditsConsumed ?? null,
  };
}

/** Fetches the current record for `taskId`. Used by the polling backstop. */
export async function fetchImageTask(
  creds: ProviderCreds,
  taskId: string,
): Promise<UpstreamRecord> {
  const data = await call(
    `${baseOf(creds)}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`,
    creds.apiKey,
    { method: 'GET' },
    RECORD_TIMEOUT_MS,
  );
  return toUpstreamRecord(data);
}
