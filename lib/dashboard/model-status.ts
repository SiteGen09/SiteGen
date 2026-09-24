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
  /** 0–1 over weighted observations, or null when the sample is too small. */
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
 * Thresholds only: the caller decides whether it has enough evidence to ask.
 * An operator's `degraded` flag is a floor, never an upgrade.
 */
function classifyRate(
  channelStatus: string,
  observations: number,
  failures: number,
): { health: ModelHealth; errorRate: number } {
  const errorRate = failures / observations;
  if (errorRate >= OUTAGE_ERROR_RATE) return { health: 'outage', errorRate };
  if (errorRate >= DEGRADED_ERROR_RATE || channelStatus === 'degraded') {
    return { health: 'degraded', errorRate };
  }
  return { health: 'operational', errorRate };
}

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
  return classifyRate(channelStatus, requests, failed);
}

/**
 * Health for one hour, from organic traffic and scheduled probes together.
 *
 * Every observation counts once, whatever its source. What a probe changes is
 * not its weight but the sample gate: organic traffic needs {@link MIN_SAMPLE}
 * requests before a rate means anything, because a handful of calls that
 * happened to fail says more about the callers than the model. A probe is a
 * deliberate check of exactly this model, so even one is evidence worth
 * reporting — which is the whole reason an untrafficked model can read green.
 *
 * An earlier version multiplied each probe into {@link MIN_SAMPLE} synthetic
 * observations to clear that gate. Counting honestly avoids both failure modes
 * that produced: a lone failed probe could outvote successful real traffic and
 * paint an outage, and — once the multiplier was applied to successes only —
 * a majority of probes could fail while the hour still read operational,
 * because the inflated denominator capped the rate below the degraded
 * threshold. Rejected requests are excluded throughout: they are the caller's
 * fault, not the model faltering.
 */
export function classifyObservedHealth(
  status: string,
  requests: number,
  failed: number,
  probes: number,
  probeFailures: number,
): { health: ModelHealth; errorRate: number | null } {
  const observations = requests + probes;
  const failures = failed + probeFailures;

  // Today's operator flag cannot invent evidence for an unobserved past hour.
  if (observations === 0) return { health: 'idle', errorRate: null };
  // No probe to vouch for the hour, and too little traffic to read a rate from.
  if (probes === 0 && requests < MIN_SAMPLE) {
    return { health: status === 'degraded' ? 'degraded' : 'idle', errorRate: null };
  }

  return classifyRate(status, observations, failures);
}

export interface ModelHour {
  hour: string;
  health: ModelHealth;
  requests: number;
  failed: number;
  probes: number;
  probeFailures: number;
}
export interface ModelHistoryRow extends ModelStatusRow {
  buckets: ModelHour[];
  availability: number | null;
}

const historySchema = z.object({
  public_model_id: z.string(),
  label: z.string(),
  channel_status: z.string(),
  bucket_hour: z.union([z.string(), z.date()]).transform((v) => new Date(v).toISOString()),
  requests: dbNumber,
  failed: dbNumber,
  rejected: dbNumber,
  probes: dbNumber,
  probe_failures: dbNumber,
  p95_latency_ms: dbNumberOrNull,
  last_success_at: dbDateOrNull,
  last_failure_at: dbDateOrNull,
});

/** Percentage of observed model-hours that were fully operational. */
export function availabilityOf(buckets: readonly Pick<ModelHour, 'health'>[]): number | null {
  const observed = buckets.filter((b) => b.health !== 'idle');
  return observed.length === 0
    ? null
    : (100 * observed.filter((b) => b.health === 'operational').length) / observed.length;
}

export async function modelStatusHistory(): Promise<{
  rows: ModelHistoryRow[];
  sla: number | null;
}> {
  // Aggregate usage and probes independently before joining. Joining the raw
  // tables would multiply request counts by probe count and distort the SLA.
  const raw = await sql.unsafe(`
    WITH eligible AS (
      SELECT c.id, c.public_model_id, c.label,
        CASE WHEN c.status='degraded' OR s.status='degraded' THEN 'degraded' ELSE 'active' END AS status
      FROM channels c JOIN sources s ON s.id=c.source_id
      WHERE c.public_model_id IS NOT NULL AND NOT c.is_byok AND c.pricing_type='token' AND c.status <> 'off' AND s.status <> 'off'
    ), models AS (
      SELECT public_model_id, min(label) AS label,
        CASE WHEN bool_or(status='degraded') THEN 'degraded' ELSE 'active' END AS channel_status
      FROM eligible GROUP BY public_model_id
    ), hours AS (
      SELECT generate_series(date_trunc('hour',now()) - interval '23 hours', date_trunc('hour',now()), interval '1 hour') AS bucket_hour
    ), usage AS (
      SELECT c.public_model_id, date_trunc('hour', u.created_at) AS bucket_hour,
        count(*) FILTER (WHERE u.status IN ('ok','failed')) AS requests,
        count(*) FILTER (WHERE u.status='failed') AS failed,
        count(*) FILTER (WHERE u.status='rejected') AS rejected
      FROM usage_events u JOIN eligible c ON c.id=u.channel_id
      WHERE u.created_at >= date_trunc('hour',now()) - interval '23 hours' AND u.created_at <= now()
      GROUP BY c.public_model_id, date_trunc('hour',u.created_at)
    ), probes AS (
      SELECT c.public_model_id, h.bucket_hour, count(*) AS probes,
        count(*) FILTER (WHERE h.status <> 'ok') AS probe_failures
      FROM model_health_checks h JOIN eligible c ON c.id=h.channel_id
      WHERE h.bucket_hour >= date_trunc('hour',now()) - interval '23 hours' AND h.bucket_hour <= now()
      GROUP BY c.public_model_id,h.bucket_hour
    ), metrics AS (
      SELECT c.public_model_id,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY u.latency_ms) FILTER (WHERE u.status='ok') AS p95_latency_ms,
        max(u.created_at) FILTER (WHERE u.status='ok') AS last_success_at,
        max(u.created_at) FILTER (WHERE u.status='failed') AS last_failure_at
      FROM eligible c LEFT JOIN usage_events u ON u.channel_id=c.id
        AND u.created_at >= date_trunc('hour',now()) - interval '23 hours' AND u.created_at <= now()
      GROUP BY c.public_model_id
    )
    SELECT m.*, h.bucket_hour, coalesce(u.requests,0) AS requests, coalesce(u.failed,0) AS failed,
      coalesce(u.rejected,0) AS rejected, coalesce(p.probes,0) AS probes, coalesce(p.probe_failures,0) AS probe_failures,
      x.p95_latency_ms,x.last_success_at,x.last_failure_at
    FROM models m CROSS JOIN hours h
    LEFT JOIN usage u USING (public_model_id,bucket_hour)
    LEFT JOIN probes p USING (public_model_id,bucket_hour)
    LEFT JOIN metrics x USING (public_model_id)
    ORDER BY m.public_model_id,h.bucket_hour
  `);
  const grouped = new Map<string, z.infer<typeof historySchema>[]>();
  for (const row of historySchema.array().parse(raw)) {
    const group = grouped.get(row.public_model_id) ?? [];
    group.push(row);
    grouped.set(row.public_model_id, group);
  }
  const rows: ModelHistoryRow[] = [];
  for (const group of grouped.values()) {
    const first = group[0]!;
    const buckets = group.map((row): ModelHour => ({
      hour: row.bucket_hour,
      health: classifyObservedHealth(
        row.channel_status,
        row.requests,
        row.failed,
        row.probes,
        row.probe_failures,
      ).health,
      requests: row.requests,
      failed: row.failed,
      probes: row.probes,
      probeFailures: row.probe_failures,
    }));
    const sum = (key: 'requests' | 'failed' | 'rejected' | 'probes' | 'probe_failures') =>
      group.reduce((n, r) => n + r[key], 0);
    const observed = classifyObservedHealth(
      first.channel_status,
      sum('requests'),
      sum('failed'),
      sum('probes'),
      sum('probe_failures'),
    );
    rows.push({
      publicModelId: first.public_model_id,
      label: first.label,
      ...observed,
      requests: sum('requests'),
      failed: sum('failed'),
      rejected: sum('rejected'),
      p95LatencyMs: first.p95_latency_ms,
      lastSuccessAt: first.last_success_at,
      lastFailureAt: first.last_failure_at,
      buckets,
      availability: availabilityOf(buckets),
    });
  }
  return { rows, sla: availabilityOf(rows.flatMap((row) => row.buckets)) };
}

/** The table and heatmap share observations and the exact same classifier. */
export async function modelStatusBoard(): Promise<ModelStatusRow[]> {
  return (await modelStatusHistory()).rows;
}
