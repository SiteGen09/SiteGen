import { z } from 'zod';

import { sql } from '@/lib/db';

/**
 * Serving health per public model, derived from recent `usage_events`.
 *
 * This is a status board, not a usage report: it aggregates across every
 * caller so a user can tell whether a model is misbehaving generally or only
 * for them. Nothing user-identifying is selected — only counts, latency
 * percentiles, and the time of the last success.
 *
 * Aggregates run on the raw Postgres connection rather than supabase-js for
 * the same reason `lib/admin/metrics.ts` does: the alternative is paging a
 * day of usage rows into the request and reducing in JS.
 *
 * Server-only. The driver hands back `unknown` (numeric/bigint arrive as
 * strings), so rows are parsed rather than asserted.
 */

const dbNumber = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === 'number' ? value : Number(value)))
  .refine(Number.isFinite, 'not a finite number');

const dbNumberOrNull = z.union([z.number(), z.string(), z.null()]).transform((value) => {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
});

const dbDateOrNull = z.union([z.date(), z.string(), z.null()]).transform((value) => {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
});

const modelHealthRowSchema = z.object({
  public_model_id: z.string(),
  label: z.string(),
  channel_status: z.string(),
  requests: dbNumber,
  failed: dbNumber,
  rejected: dbNumber,
  p95_latency_ms: dbNumberOrNull,
  last_success_at: dbDateOrNull,
  last_failure_at: dbDateOrNull,
});

/**
 * `operational` — serving normally. `degraded` — errors above
 * {@link DEGRADED_ERROR_RATE}, or an operator has flagged the channel.
 * `outage` — errors above {@link OUTAGE_ERROR_RATE}. `idle` — too few requests
 * in the window to say anything, so the operator's own flag is all we have.
 */
export type ModelHealth = 'operational' | 'degraded' | 'outage' | 'idle';

export interface ModelStatusRow {
  publicModelId: string;
  label: string;
  health: ModelHealth;
  /** Total requests in the window, successful or not. */
  requests: number;
  /** Upstream failures. Excludes `rejected`, which is the caller's fault. */
  failed: number;
  /** Requests turned away before dispatch (bad input, moderation, credits). */
  rejected: number;
  /** 0–1 over `requests`, or null when the sample is too small to mean anything. */
  errorRate: number | null;
  p95LatencyMs: number | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

/** Hours of history the board summarises. */
export const STATUS_WINDOW_HOURS = 24;

/**
 * Below this many requests a single failure would read as a 50% error rate, so
 * the row stays `idle` rather than crying outage over a sample of two.
 */
const MIN_SAMPLE = 10;

const DEGRADED_ERROR_RATE = 0.1;
const OUTAGE_ERROR_RATE = 0.5;

/**
 * Pure classifier, exported for tests: everything above it is I/O.
 */
export function classifyModelHealth(
  channelStatus: string,
  requests: number,
  failed: number,
): { health: ModelHealth; errorRate: number | null } {
  if (requests < MIN_SAMPLE) {
    // No usable signal: defer to whatever an operator set on the channel.
    return { health: channelStatus === 'degraded' ? 'degraded' : 'idle', errorRate: null };
  }

  const errorRate = failed / requests;
  if (errorRate >= OUTAGE_ERROR_RATE) return { health: 'outage', errorRate };
  if (errorRate >= DEGRADED_ERROR_RATE || channelStatus === 'degraded') {
    return { health: 'degraded', errorRate };
  }
  return { health: 'operational', errorRate };
}

/**
 * One row per addressable model, worst health first so anything broken is at
 * the top. Models with no traffic in the window are included as `idle` — an
 * absent row would be indistinguishable from a model that was removed.
 */
export async function modelStatusBoard(): Promise<ModelStatusRow[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT
      c.public_model_id,
      c.label,
      c.status AS channel_status,
      count(u.request_id) AS requests,
      count(u.request_id) FILTER (WHERE u.status = 'failed') AS failed,
      count(u.request_id) FILTER (WHERE u.status = 'rejected') AS rejected,
      percentile_cont(0.95) WITHIN GROUP (
        ORDER BY u.latency_ms
      ) FILTER (WHERE u.status = 'ok') AS p95_latency_ms,
      max(u.created_at) FILTER (WHERE u.status = 'ok') AS last_success_at,
      max(u.created_at) FILTER (WHERE u.status = 'failed') AS last_failure_at
    FROM channels c
    LEFT JOIN usage_events u
      ON u.channel_id = c.id
     AND u.created_at >= now() - make_interval(hours => ${STATUS_WINDOW_HOURS})
    WHERE c.public_model_id IS NOT NULL
      AND c.status <> 'off'
    GROUP BY c.public_model_id, c.label, c.status
  `;

  const RANK: Record<ModelHealth, number> = { outage: 0, degraded: 1, idle: 2, operational: 3 };

  return rows
    .map((raw) => {
      const row = modelHealthRowSchema.parse(raw);
      const { health, errorRate } = classifyModelHealth(row.channel_status, row.requests, row.failed);
      return {
        publicModelId: row.public_model_id,
        label: row.label,
        health,
        requests: row.requests,
        failed: row.failed,
        rejected: row.rejected,
        errorRate,
        p95LatencyMs: row.p95_latency_ms,
        lastSuccessAt: row.last_success_at,
        lastFailureAt: row.last_failure_at,
      };
    })
    .sort((left, right) => {
      const delta = RANK[left.health] - RANK[right.health];
      return delta !== 0 ? delta : left.publicModelId.localeCompare(right.publicModelId);
    });
}
