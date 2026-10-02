import { isPolicyRejection } from '@/lib/guardrails/policy';
import { upstreamStatus } from '@/lib/ai/fallback';
import { asUpstreamError } from '@/lib/api/upstream';
import { sql } from '@/lib/db';

/**
 * Records failed upstream attempts for the admin failure alert (see
 * scanUpstreamHealth in lib/notifications/scan.ts). usage_events only keeps a
 * request's final outcome, so a provider that fails while fallback keeps users
 * served would otherwise never show up.
 */

/** Refusals of the request itself say nothing about the provider's health. */
const CALLER_ERRORS = new Set([400, 413, 422]);

/** Whether a failed attempt reflects on the provider rather than on the request. */
export function isProviderFailure(err: unknown): boolean {
  if (isPolicyRejection(err)) return false;
  const status = upstreamStatus(err);
  return status === undefined || !CALLER_ERRORS.has(status);
}

export function failureCode(err: unknown): string {
  const status = upstreamStatus(err);
  return (asUpstreamError(err)?.code ?? (status !== undefined ? `http_${status}` : 'network_error')).slice(0, 100);
}

/**
 * Fire-and-forget: a request never waits on, or fails because of, this write.
 * Skipped under the test runner, which loads `.env.local` and would otherwise
 * write test failures into whatever database that names.
 */
export function recordAttemptFailure(channelId: string, err: unknown): void {
  if (process.env.VITEST || !isProviderFailure(err)) return;
  const status = upstreamStatus(err) ?? null;
  void sql`
    INSERT INTO upstream_attempt_failures (channel_id, http_status, error_code)
    VALUES (${channelId}, ${status}, ${failureCode(err)})`.catch(() => undefined);
}
