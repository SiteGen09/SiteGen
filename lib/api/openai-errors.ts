import { ApiError, type ErrorCode } from '@/lib/api/errors';
import { asUpstreamError } from '@/lib/api/upstream';

/**
 * Renders an {@link ApiError} into OpenAI's error envelope, used only by the
 * gateway routes. The OpenAI SDK reads `error.message`, `error.type`, and
 * `error.code`; given our internal `{code, message, request_id}` shape it would
 * surface `undefined` to a customer. `request_id` is kept as an extra field for
 * support without disturbing the SDK's parsing.
 *
 * `/v1/generate` keeps its own envelope (see `lib/api/errors.ts#apiError`); this
 * mapper is not used there.
 */

/** OpenAI's `error.type` values, mapped from our internal codes. */
const TYPE_BY_CODE: Record<ErrorCode, string> = {
  unauthorized: 'invalid_request_error',
  forbidden: 'invalid_request_error',
  invalid_request: 'invalid_request_error',
  rate_limited: 'rate_limit_error',
  insufficient_credits: 'insufficient_quota',
  idempotency_conflict: 'invalid_request_error',
  channel_unavailable: 'api_error',
  generation_failed: 'api_error',
  not_found: 'invalid_request_error',
  model_not_found: 'invalid_request_error',
  not_ready: 'invalid_request_error',
  content_policy_violation: 'invalid_request_error',
  internal_error: 'api_error',
};

/**
 * OpenAI's `error.code` string. Mostly the same token as our internal code,
 * but a few are renamed to the values OpenAI clients expect to branch on.
 */
const OPENAI_CODE_BY_CODE: Partial<Record<ErrorCode, string>> = {
  insufficient_credits: 'insufficient_quota',
  rate_limited: 'rate_limit_exceeded',
  unauthorized: 'invalid_api_key',
};

export interface OpenAiErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
    request_id: string;
  };
}

export function openAiErrorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
): OpenAiErrorBody {
  return {
    error: {
      message,
      type: TYPE_BY_CODE[code],
      param: null,
      code: OPENAI_CODE_BY_CODE[code] ?? code,
      request_id: requestId,
    },
  };
}

/** Builds the OpenAI-shaped `Response` for an error. */
export function openAiError(
  code: ErrorCode,
  message: string,
  requestId: string,
  status: number,
  headers?: Record<string, string>,
): Response {
  return Response.json(openAiErrorBody(code, message, requestId), { status, headers });
}

/**
 * Converts a thrown value into an OpenAI-shaped error response. An `ApiError`
 * keeps its code, message, and status; anything else becomes a generic
 * `internal_error` so upstream provider text, stack traces, and credential
 * details never reach the caller — the detail is the caller's to log.
 */
export function openAiErrorFrom(err: unknown, requestId: string): Response {
  if (err instanceof ApiError) {
    return openAiError(err.code, err.message, requestId, err.status);
  }
  // A provider fault is not our fault: reporting it as 500 tells the caller to
  // stop retrying and charges a provider outage to our own error budget.
  const upstream = asUpstreamError(err);
  if (upstream !== null) {
    return openAiError(upstream.code, upstream.message, requestId, upstream.status);
  }
  return openAiError('internal_error', 'an unexpected error occurred', requestId, 500);
}
