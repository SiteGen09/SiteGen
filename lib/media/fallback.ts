import { ApiError } from '@/lib/api/errors';
import { isPolicyRejection } from '@/lib/guardrails/policy';

/** A provider explicitly refused the submission and did not accept a job. */
export class MediaSubmissionError extends ApiError {
  constructor(message: string, readonly upstreamStatus: number) {
    super('channel_unavailable', message, 502);
  }
}

export function canRetryMediaSubmission(error: unknown): boolean {
  if (isPolicyRejection(error)) return false;
  if (!(error instanceof MediaSubmissionError)) return false;
  return [401, 402, 404, 429].includes(error.upstreamStatus) ||
    (error.upstreamStatus >= 500 && error.upstreamStatus < 600);
}

/** Never retry ambiguous timeouts, missing task IDs, or failures after acceptance. */
export async function submitWithFallback<T, R>(
  candidates: readonly T[],
  attempt: (candidate: T, index: number) => Promise<R>,
): Promise<R> {
  for (const [index, candidate] of candidates.slice(0, 5).entries()) {
    try { return await attempt(candidate, index); } catch (error) {
      if (index === Math.min(candidates.length, 5) - 1 || !canRetryMediaSubmission(error)) throw error;
    }
  }
  throw new ApiError('channel_unavailable', 'no available media provider', 503);
}
