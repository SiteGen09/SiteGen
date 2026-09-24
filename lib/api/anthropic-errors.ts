import { ApiError, type ErrorCode } from '@/lib/api/errors';
import { asUpstreamError } from '@/lib/api/upstream';

/**
 * Renders an {@link ApiError} into Anthropic's error envelope, used only by
 * `/v1/messages`.
 *
 * Anthropic SDKs branch on `error.type` and surface `error.message`; handed
 * OpenAI's `{message, type, param, code}` shape they would report `undefined`
 * to the caller. `request_id` is carried as an extra top-level field for
 * support, which the SDKs ignore rather than reject.
 *
 * Kept separate from `openai-errors.ts` rather than parameterised: the two
 * vocabularies do not line up one to one, and a shared mapper would have to be
 * read twice to answer what either protocol actually emits.
 */

/** Anthropic's `error.type` values, mapped from our internal codes. */
const TYPE_BY_CODE: Record<ErrorCode, string> = {
  unauthorized: 'authentication_error',
  forbidden: 'permission_error',
  invalid_request: 'invalid_request_error',
  rate_limited: 'rate_limit_error',
  // Anthropic has no billing-specific type; its SDKs treat 402 generically.
  insufficient_credits: 'invalid_request_error',
  idempotency_conflict: 'invalid_request_error',
  channel_unavailable: 'api_error',
  generation_failed: 'api_error',
  not_found: 'not_found_error',
  model_not_found: 'not_found_error',
  not_ready: 'invalid_request_error',
  content_policy_violation: 'invalid_request_error',
  internal_error: 'api_error',
};

export interface AnthropicErrorBody {
  type: 'error';
  error: { type: string; message: string };
  request_id: string;
}

export function anthropicErrorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
): AnthropicErrorBody {
  return {
    type: 'error',
    error: { type: TYPE_BY_CODE[code], message },
    request_id: requestId,
  };
}

/** Builds the Anthropic-shaped `Response` for an error. */
export function anthropicError(
  code: ErrorCode,
  message: string,
  requestId: string,
  status: number,
  headers?: Record<string, string>,
): Response {
  return Response.json(anthropicErrorBody(code, message, requestId), { status, headers });
}

/**
 * Maps any thrown value to an Anthropic-shaped response. An unrecognised
 * throw becomes a generic 500 rather than leaking an internal message.
 */
export function anthropicErrorFrom(err: unknown, requestId: string): Response {
  if (err instanceof ApiError) {
    return anthropicError(err.code, err.message, requestId, err.status);
  }
  // A provider fault is not our fault: reporting it as 500 tells the caller to
  // stop retrying and charges a provider outage to our own error budget.
  const upstream = asUpstreamError(err);
  if (upstream !== null) {
    return anthropicError(upstream.code, upstream.message, requestId, upstream.status);
  }
  return anthropicError('internal_error', 'an unexpected error occurred', requestId, 500);
}
