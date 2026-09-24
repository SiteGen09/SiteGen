import { ApiError } from '@/lib/api/errors';
import { asUpstreamError } from '@/lib/api/upstream';
import { describeError, type ChatError } from '@/lib/chat/errors';

/**
 * Error envelope for the session-authenticated dashboard routes (`/api/chat`,
 * `/api/media`). Their only reader is the dashboard UI, so the message is
 * worded for a person; the internal `code` and `request_id` stay alongside for
 * support. The `/v1` gateway keeps its own envelopes (see `openai-errors.ts`).
 */

/** Anything that is neither ours nor a recognised provider fault stays generic. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return asUpstreamError(err) ?? new ApiError('internal_error', 'an unexpected error occurred', 500);
}

export function dashboardError(err: unknown, requestId: string): ChatError & { code: string } {
  const error = toApiError(err);
  const retryAfter = (err as { retryAfter?: unknown } | null)?.retryAfter;
  return {
    ...describeError({
      code: error.code,
      message: error.message,
      status: error.status,
      required: error.details?.required,
      balance: error.details?.balance,
      retryAfter: typeof retryAfter === 'number' ? retryAfter : undefined,
    }),
    code: error.code,
    request_id: requestId,
  };
}

export function dashboardErrorFrom(err: unknown, requestId: string): Response {
  return Response.json({ error: dashboardError(err, requestId) }, { status: toApiError(err).status });
}
