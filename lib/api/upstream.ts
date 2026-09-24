import { isPolicyRejection } from '@/lib/guardrails/policy';
import { APICallError, EmptyResponseBodyError, RetryError } from 'ai';

import { ApiError } from '@/lib/api/errors';

/**
 * Classifies a failure that came from an upstream provider rather than from us.
 *
 * Without this everything the AI SDK throws lands in the generic catch and is
 * reported as `internal_error` with a 500 — which tells the caller the fault is
 * ours, tells their client not to fall back, and buries a provider outage in
 * our own error budget.
 *
 * The case that made this necessary: a gateway that answers HTTP 200 with an
 * error envelope in the body (`{"code":524,"msg":"2 times retry fail"}`). The
 * OpenAI-compatible client cannot parse that against its schema and raises
 * `APICallError: Invalid JSON response`, which looks like a bug in our
 * serialization and is nothing of the sort.
 *
 * Returns null for anything that is genuinely not an upstream fault, so a real
 * bug of ours still surfaces as a 500.
 */

/**
 * Upstream status codes that describe the caller's request rather than the
 * provider's health. Passing these through as 502 would tell a caller to
 * retry something that will never succeed.
 */
const CALLER_FAULT_STATUS = new Set([400, 404, 413, 422]);

function fromApiCall(err: APICallError): ApiError {
  const status = err.statusCode ?? null;

  if (status === 401 || status === 403) {
    // Their key, not the caller's: a credential problem is ours to fix, and
    // saying "unauthorized" here would tell the caller their key is bad.
    return new ApiError(
      'channel_unavailable',
      'the upstream provider rejected our credentials',
      503,
    );
  }
  if (status === 429) {
    return new ApiError('channel_unavailable', 'the upstream provider is rate limiting us', 503);
  }
  if (status !== null && CALLER_FAULT_STATUS.has(status)) {
    return new ApiError('invalid_request', `the model rejected this request: ${err.message}`, 400);
  }
  if (status !== null && status >= 500) {
    return new ApiError('channel_unavailable', 'the upstream provider is unavailable', 503);
  }
  // No status, or a 200 carrying an error envelope: the provider answered, but
  // not with anything usable.
  return new ApiError('generation_failed', `the model returned an unusable response`, 502);
}

export function asUpstreamError(err: unknown): ApiError | null {
  if (isPolicyRejection(err)) return new ApiError('content_policy_violation', 'the provider rejected this request under its content policy', 400);
  if (APICallError.isInstance(err)) return fromApiCall(err);
  if (EmptyResponseBodyError.isInstance(err)) {
    return new ApiError('generation_failed', 'the model returned an empty response', 502);
  }
  // A retry error wraps the attempts; the last one carries the real cause.
  if (RetryError.isInstance(err)) {
    const last = err.errors.at(-1);
    return last === undefined ? null : asUpstreamError(last);
  }
  return null;
}
