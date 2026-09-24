import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';

import { MEDIA_UPSTREAM_USD_PER_CREDIT, USD_PER_CREDIT } from '@/lib/ai/pricing';
import { sql } from '@/lib/db';

export const USAGE_RANGES = { '24h': 'Last 24 hours', '7d': 'Last 7 days', '30d': 'Last 30 days' } as const;
// Revenue is credits at a fixed rate, so ranking by credits ranks by revenue.
export const USAGE_SORTS = {
  requests: 'Requests', consumers: 'Consumers', credits: 'Revenue', cost: 'Provider cost', profit: 'Gross profit',
} as const;
export type UsageRange = keyof typeof USAGE_RANGES;
export type UsageSort = keyof typeof USAGE_SORTS;

export function parseUsageRange(value: unknown): UsageRange {
  return value === '7d' || value === '30d' ? value : '24h';
}

export function parseUsageSort(value: unknown): UsageSort {
  return value === 'consumers' || value === 'credits' || value === 'cost' || value === 'profit' ? value : 'requests';
}

const number = z.coerce.number().finite();

/**
 * Money columns shared by every breakdown. See {@link attributedEvents} for
 * how each request's revenue and provider cost are derived.
 */
function economicsShape() {
  return {
    /** Credits consumed, valued at USD_PER_CREDIT. */
    revenue_usd: number,
    /** What the platform paid providers, over requests whose cost is known. */
    provider_cost_usd: number,
    /** Revenue minus provider cost, over requests whose cost is known. */
    profit_usd: number,
    /** Revenue from requests with no known cost; left out of profit. */
    unpriced_revenue_usd: number,
    unpriced_requests: number,
    /** Media requests whose cost was recovered from settlement or markup. */
    estimated_cost_requests: number,
    byok_requests: number,
    /** Requests that earned nothing but cost the platform money. */
    unearned_cost_requests: number,
    unearned_cost_usd: number,
  };
}

const totalsSchema = z.object({
  requests: number,
  consumers: number,
  successful_requests: number,
  errors: number,
  credits: number,
  cost_usd: number,
  missing_cost_requests: number,
  input_tokens: number,
  output_tokens: number,
  cached_tokens: number,
  p95_latency_ms: number.nullable(),
  legacy_requests: number,
  ...economicsShape(),
});

const rowSchema = totalsSchema.extend({
  grouping: number,
  model_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  channel_label: z.string().nullable(),
  source_id: z.string().nullable(),
  source_label: z.string().nullable(),
  provider: z.string().nullable(),
  task: z.string().nullable(),
});

export type UsageTotals = z.infer<typeof totalsSchema>;
export type UsageBreakdown = Omit<z.infer<typeof rowSchema>, 'grouping'>;
export interface UsageMonitoring {
  summary: UsageTotals;
  models: UsageBreakdown[];
  routes: UsageBreakdown[];
}

type Connection = Sql | TransactionSql;

function rangeHours(range: UsageRange): number {
  return range === '30d' ? 720 : range === '7d' ? 168 : 24;
}

/**
 * Provider cost of a finished media job, which records no cost_usd. The settle
 * row keeps the upstream's reported credit count when there is one; relay
 * images and jobs without a report fall back to the credits charged divided by
 * the job's markup, which is the cost the charge was computed from (to within
 * the one-credit rounding).
 */
function mediaProviderCost(connection: Connection) {
  return connection`
    SELECT COALESCE(
      CASE WHEN jsonb_typeof(l.meta -> 'upstream_credits') = 'number'
        THEN (l.meta ->> 'upstream_credits')::numeric * ${MEDIA_UPSTREAM_USD_PER_CREDIT}::numeric END,
      CASE WHEN m.credit_multiplier > 0
        THEN COALESCE(a.credits_charged, 0) * ${USD_PER_CREDIT}::numeric / m.credit_multiplier END)
    FROM media_jobs m
    LEFT JOIN ledger l ON l.request_id = m.request_id || ':settle'
    WHERE m.request_id = a.request_id
  `;
}

/**
 * usage_events with the model, channel and source recorded at settlement,
 * plus what each request earned and cost. Legacy rows fall back to current
 * catalog labels; source history is never guessed. `hours` bounds the window;
 * without it only future rows are cut.
 *
 * Revenue is the credits charged at USD_PER_CREDIT. Provider cost is the
 * recorded cost_usd, zero for BYOK (the caller's key paid), or the media
 * estimate above; it stays null when nothing is known, and such rows are kept
 * out of profit rather than counted as free.
 */
function attributedEvents(connection: Connection, filter: { hours?: number; userId?: string }) {
  return connection`
    SELECT a.*,
      COALESCE(a.credits_charged, 0) * ${USD_PER_CREDIT}::numeric AS revenue_usd,
      CASE
        WHEN a.byok THEN 0
        WHEN a.cost_usd IS NOT NULL THEN a.cost_usd
        WHEN a.status = 'ok' THEN (${mediaProviderCost(connection)})
      END AS provider_cost_usd
    FROM (
      SELECT u.*,
        CASE WHEN r.request_id IS NOT NULL THEN r.model_id
          ELSE COALESCE(c.public_model_id, c.model_id) END AS served_model,
        COALESCE(r.channel_label, c.label) AS served_channel_label,
        CASE WHEN r.request_id IS NOT NULL THEN r.source_id ELSE u.source_id END AS served_source,
        CASE WHEN r.request_id IS NOT NULL THEN r.source_label
          WHEN u.source_id IS NOT NULL OR u.source_label = 'BYOK' THEN u.source_label
          ELSE NULL END AS served_source_label,
        CASE WHEN r.request_id IS NOT NULL THEN r.provider ELSE c.provider END AS served_provider,
        CASE WHEN r.request_id IS NOT NULL THEN r.task ELSE c.task END AS served_task,
        r.request_id IS NULL AND u.channel_id IS NOT NULL AS legacy,
        COALESCE(r.source_label, u.source_label, '') = 'BYOK' AS byok
      FROM usage_events u
      LEFT JOIN usage_route_snapshots r ON r.request_id = u.request_id
      LEFT JOIN channels c ON c.id = u.channel_id
      WHERE u.created_at <= now()
        ${filter.hours === undefined ? connection`` : connection`AND u.created_at >= now() - ${filter.hours} * interval '1 hour'`}
        ${filter.userId === undefined ? connection`` : connection`AND u.user_id = ${filter.userId}`}
    ) a
  `;
}

/** Aggregates for {@link economicsShape}, over rows of {@link attributedEvents}. */
function economicsColumns(connection: Connection) {
  return connection`
    COALESCE(sum(revenue_usd), 0) AS revenue_usd,
    COALESCE(sum(provider_cost_usd), 0) AS provider_cost_usd,
    COALESCE(sum(revenue_usd - provider_cost_usd), 0) AS profit_usd,
    COALESCE(sum(revenue_usd) FILTER (WHERE provider_cost_usd IS NULL), 0) AS unpriced_revenue_usd,
    count(*) FILTER (WHERE provider_cost_usd IS NULL AND credits_charged > 0) AS unpriced_requests,
    count(*) FILTER (WHERE cost_usd IS NULL AND NOT byok AND provider_cost_usd IS NOT NULL) AS estimated_cost_requests,
    count(*) FILTER (WHERE byok) AS byok_requests,
    count(*) FILTER (WHERE COALESCE(credits_charged, 0) = 0 AND provider_cost_usd > 0) AS unearned_cost_requests,
    COALESCE(sum(provider_cost_usd) FILTER (WHERE COALESCE(credits_charged, 0) = 0 AND provider_cost_usd > 0), 0)
      AS unearned_cost_usd
  `;
}

/**
 * Admin-only, called after requireAdmin. Aggregate at the database boundary,
 * including distinct users at each level (never sum route-level users).
 * A single statement gives the summary and both rankings the same snapshot.
 * `scope.userId` narrows every figure to one account for the user detail page.
 */
export async function usageMonitoring(
  range: UsageRange,
  sort: UsageSort,
  connection: Connection = sql,
  scope: { userId?: string } = {},
): Promise<UsageMonitoring> {
  const rows = await connection<Record<string, unknown>[]>`
    WITH events AS (${attributedEvents(connection, { hours: rangeHours(range), userId: scope.userId })})
    SELECT
      GROUPING(served_model, channel_id) AS grouping,
      served_model AS model_id, channel_id, served_channel_label AS channel_label,
      served_source AS source_id, served_source_label AS source_label,
      served_provider AS provider, served_task AS task,
      count(*) AS requests, count(DISTINCT user_id) AS consumers,
      count(*) FILTER (WHERE status = 'ok') AS successful_requests,
      count(*) FILTER (WHERE status <> 'ok') AS errors,
      COALESCE(sum(credits_charged), 0) AS credits,
      COALESCE(sum(cost_usd), 0) AS cost_usd,
      count(*) FILTER (WHERE status = 'ok' AND cost_usd IS NULL) AS missing_cost_requests,
      COALESCE(sum(input_tokens), 0) AS input_tokens,
      COALESCE(sum(output_tokens), 0) AS output_tokens,
      COALESCE(sum(cached_tokens), 0) AS cached_tokens,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE status = 'ok') AS p95_latency_ms,
      count(*) FILTER (WHERE legacy) AS legacy_requests,
      ${economicsColumns(connection)}
    FROM events
    GROUP BY GROUPING SETS (
      (), (served_model),
      (served_model, channel_id, served_channel_label, served_source, served_source_label, served_provider, served_task)
    )
  `;

  const parsed = rows.map((row) => rowSchema.parse(row));
  const summary = parsed.find((row) => row.grouping === 3);
  if (!summary) throw new Error('Usage monitoring summary was not returned');
  const key = sort === 'cost' ? 'provider_cost_usd' : sort === 'profit' ? 'profit_usd' : sort;
  const ranked = (grouping: number) => parsed.filter((row) => row.grouping === grouping).sort((a, b) =>
    b[key] - a[key] || b.requests - a.requests ||
    JSON.stringify([a.model_id, a.channel_id, a.source_id, a.source_label]).localeCompare(
      JSON.stringify([b.model_id, b.channel_id, b.source_id, b.source_label]),
    ),
  );
  return { summary: totalsSchema.parse(summary), models: ranked(1), routes: ranked(0) };
}

const consumerSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  requests: number,
  errors: number,
  credits: number,
  tokens: number,
  last_used_at: z.coerce.date(),
  balance: number,
  ...economicsShape(),
});

export type Consumer = z.infer<typeof consumerSchema>;

/**
 * Accounts that spent the most credits (so earned the most revenue) in the
 * window, with what serving them cost. Balance is read only for the rows that
 * survive the LIMIT, not for every active account.
 */
export async function topConsumers(
  range: UsageRange,
  limit: number,
  connection: Connection = sql,
): Promise<Consumer[]> {
  const rows = await connection<Record<string, unknown>[]>`
    SELECT t.*, get_balance(t.user_id) AS balance
    FROM (
      SELECT e.user_id, p.email,
        count(*) AS requests,
        count(*) FILTER (WHERE e.status <> 'ok') AS errors,
        COALESCE(sum(e.credits_charged), 0) AS credits,
        COALESCE(sum(e.input_tokens), 0) + COALESCE(sum(e.output_tokens), 0)
          + COALESCE(sum(e.cached_tokens), 0) AS tokens,
        max(e.created_at) AS last_used_at,
        ${economicsColumns(connection)}
      FROM (${attributedEvents(connection, { hours: rangeHours(range) })}) e
      JOIN profiles p ON p.id = e.user_id
      GROUP BY e.user_id, p.email
      ORDER BY COALESCE(sum(e.credits_charged), 0) DESC, count(*) DESC, e.user_id
      LIMIT ${limit}
    ) t
    ORDER BY t.credits DESC, t.requests DESC, t.user_id
  `;
  return rows.map((row) => consumerSchema.parse(row));
}

const recentRequestSchema = z.object({
  request_id: z.string(),
  user_id: z.string(),
  email: z.string(),
  status: z.string(),
  created_at: z.coerce.date(),
  latency_ms: number.nullable(),
  input_tokens: number.nullable(),
  output_tokens: number.nullable(),
  cached_tokens: number.nullable(),
  credits_charged: number.nullable(),
  cost_usd: number.nullable(),
  revenue_usd: number,
  /** Null when the cost is unknown; zero for BYOK. */
  provider_cost_usd: number.nullable(),
  byok: z.boolean(),
  cost_estimated: z.boolean(),
  model_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  channel_label: z.string().nullable(),
  source_label: z.string().nullable(),
});

export type RecentRequest = z.infer<typeof recentRequestSchema>;

/** Newest request outcomes, across every account or for one. */
export async function recentRequests(
  filter: { userId?: string; limit: number },
  connection: Connection = sql,
): Promise<RecentRequest[]> {
  const rows = await connection<Record<string, unknown>[]>`
    SELECT e.request_id, e.user_id, p.email, e.status, e.created_at, e.latency_ms,
      e.input_tokens, e.output_tokens, e.cached_tokens, e.credits_charged, e.cost_usd,
      e.revenue_usd, e.provider_cost_usd, e.byok,
      e.cost_usd IS NULL AND NOT e.byok AND e.provider_cost_usd IS NOT NULL AS cost_estimated,
      e.served_model AS model_id, e.channel_id, e.served_channel_label AS channel_label,
      e.served_source_label AS source_label
    FROM (${attributedEvents(connection, { userId: filter.userId })}) e
    JOIN profiles p ON p.id = e.user_id
    ORDER BY e.created_at DESC, e.request_id DESC
    LIMIT ${filter.limit}
  `;
  return rows.map((row) => recentRequestSchema.parse(row));
}
