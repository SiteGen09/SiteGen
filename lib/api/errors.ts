export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'invalid_request',
  'rate_limited',
  'insufficient_credits',
  'idempotency_conflict',
  'channel_unavailable',
  'generation_failed',
  'not_found',
  'model_not_found',
  'not_ready',
  'content_policy_violation',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function apiError(
  code: ErrorCode,
  message: string,
  requestId: string,
  status: number,
): Response {
  return Response.json({ error: { code, message, request_id: requestId } }, { status });
}

/** Figures a person-facing message can quote, such as a credit shortfall. */
export interface ErrorDetails {
  required?: number;
  balance?: number;
}

/** Thrown internally and converted to a response by route handlers via `apiError`. */
export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number,
    public details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
