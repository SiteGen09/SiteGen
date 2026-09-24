import { z } from 'zod';

import { sql } from '@/lib/db';

/**
 * Read-only aggregate queries for the admin portal.
 *
 * These go through the raw Postgres connection rather than supabase-js because
 * every one of them is a GROUP BY / percentile aggregate: the alternative is
 * paging whole tables into the request and reducing in JS, which would allocate
 * a full day of usage rows per page view. Writes still go through the
 * service-role client so the audit path stays uniform.
 *
 * Server-only. Row shapes are parsed rather than asserted because the driver
 * hands back `unknown` values (numeric/bigint arrive as strings).
 */

/** Postgres `numeric`/`bigint` arrive as strings; `int`/`float8` as numbers. */
const dbNumber = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === 'number' ? value : Number(value)))
  .refine(Number.isFinite, 'not a finite number');

const dbNumberOrNull = z
  .union([z.number(), z.string(), z.null()])
  .transform((value) => {
    if (value === null) return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  });

const dbDate = z
  .union([z.date(), z.string()])
  .transform((value) => (value instanceof Date ? value : new Date(value)));

const dbDateOrNull = z
  .union([z.date(), z.string(), z.null()])
  .transform((value) => {
    if (value === null) return null;
    return value instanceof Date ? value : new Date(value);
  });

const usageSummarySchema = z.object({
  requests: dbNumber,
  errors: dbNumber,
  p95_latency_ms: dbNumberOrNull,
  credits: dbNumber,
  cost_usd: dbNumber,
});

export type UsageSummary = z.infer<typeof usageSummarySchema>;

const channelUsageSchema = z.object({
  channel_id: z.string(),
  requests: dbNumber,
  errors: dbNumber,
  p95_latency_ms: dbNumberOrNull,
  credits: dbNumber,
  cost_usd: dbNumber,
});

export type ChannelUsage = z.infer<typeof channelUsageSchema>;

const negativeBalanceSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  balance: dbNumber,
});

export type NegativeBalance = z.infer<typeof negativeBalanceSchema>;

/** Rolling 24-hour totals across every channel. */
export async function usageSummary24h(): Promise<UsageSummary> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT
      count(*) AS requests,
      count(*) FILTER (WHERE status <> 'ok') AS errors,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms,
      COALESCE(SUM(credits_charged), 0) AS credits,
      COALESCE(SUM(cost_usd), 0) AS cost_usd
    FROM usage_events
    WHERE created_at >= now() - interval '24 hours'
  `;

  const row = rows[0];
  if (row === undefined) {
    return { requests: 0, errors: 0, p95_latency_ms: null, credits: 0, cost_usd: 0 };
  }
  return usageSummarySchema.parse(row);
}

/** Rolling 24-hour totals grouped by channel, most expensive first. */
export async function usageByChannel24h(): Promise<ChannelUsage[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT
      channel_id,
      count(*) AS requests,
      count(*) FILTER (WHERE status <> 'ok') AS errors,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms,
      COALESCE(SUM(credits_charged), 0) AS credits,
      COALESCE(SUM(cost_usd), 0) AS cost_usd
    FROM usage_events
    WHERE created_at >= now() - interval '24 hours'
    GROUP BY channel_id
    ORDER BY COALESCE(SUM(cost_usd), 0) DESC, channel_id ASC
  `;

  return rows.map((row) => channelUsageSchema.parse(row));
}

/**
 * Users whose derived credit balance is below zero. A non-empty result means
 * the hold/settle path let someone overdraw and needs investigation.
 */
export async function negativeBalances(): Promise<NegativeBalance[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT l.user_id, p.email, SUM(l.credits) AS balance
    FROM ledger l
    JOIN profiles p ON p.id = l.user_id
    GROUP BY l.user_id, p.email
    HAVING SUM(l.credits) < 0
    ORDER BY SUM(l.credits) ASC
    LIMIT 50
  `;

  return rows.map((row) => negativeBalanceSchema.parse(row));
}

const auditEntrySchema = z.object({
  id: dbNumber,
  actor_id: z.string(),
  actor_email: z.string().nullable(),
  action: z.string(),
  target: z.string(),
  before: z.unknown(),
  after: z.unknown(),
  created_at: dbDate,
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** Newest-first page of the admin audit log. */
export async function auditPage(
  limit: number,
  offset: number,
): Promise<{ entries: AuditEntry[]; total: number }> {
  const [rows, counts] = await Promise.all([
    sql<Record<string, unknown>[]>`
      SELECT a.id, a.actor_id, p.email AS actor_email, a.action, a.target,
             a.before, a.after, a.created_at
      FROM admin_audit_log a
      LEFT JOIN profiles p ON p.id = a.actor_id
      ORDER BY a.id DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    sql<Record<string, unknown>[]>`SELECT count(*) AS total FROM admin_audit_log`,
  ]);

  const countRow = counts[0];
  return {
    entries: rows.map((row) => auditEntrySchema.parse(row)),
    total: countRow === undefined ? 0 : dbNumber.parse(countRow.total),
  };
}

const userRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  status: z.string(),
  created_at: dbDate,
  plan_key: z.string().nullable(),
  entitlement_status: z.string().nullable(),
  current_period_end: dbDateOrNull,
  monthly_credits: dbNumberOrNull,
  balance: dbNumber,
  credits_30d: dbNumber,
  last_used_at: dbDateOrNull,
  strikes_24h: dbNumber,
});

export type UserRow = z.infer<typeof userRowSchema>;

/**
 * Page of users with their entitlement and recent consumption, newest signups
 * first. The usage subqueries run per listed user on the (user_id, created_at)
 * index, never across the whole table.
 */
export async function usersPage(
  limit: number,
  offset: number,
): Promise<{ users: UserRow[]; total: number }> {
  const [rows, counts] = await Promise.all([
    sql<Record<string, unknown>[]>`
      SELECT p.id, p.email, p.role, p.status, p.created_at,
             e.plan_key,
             e.status AS entitlement_status,
             e.current_period_end,
             e.monthly_credits,
             get_balance(p.id) AS balance,
             (SELECT COALESCE(SUM(u.credits_charged), 0) FROM usage_events u
                WHERE u.user_id = p.id
                  AND u.created_at >= now() - interval '30 days') AS credits_30d,
             (SELECT max(u.created_at) FROM usage_events u
                WHERE u.user_id = p.id) AS last_used_at,
             (SELECT count(*) FROM abuse_strikes s
                WHERE s.user_id = p.id
                  AND s.created_at >= now() - interval '24 hours') AS strikes_24h
      FROM profiles p
      LEFT JOIN entitlements e ON e.user_id = p.id
      ORDER BY p.created_at DESC, p.id ASC
      LIMIT ${limit} OFFSET ${offset}
    `,
    sql<Record<string, unknown>[]>`SELECT count(*) AS total FROM profiles`,
  ]);

  const countRow = counts[0];
  return {
    users: rows.map((row) => userRowSchema.parse(row)),
    total: countRow === undefined ? 0 : dbNumber.parse(countRow.total),
  };
}

const sourceUsageSchema = z.object({
  source_id: z.string(),
  source_label: z.string(),
  requests: dbNumber,
  errors: dbNumber,
  p95_latency_ms: dbNumberOrNull,
  credits: dbNumber,
  cost_usd: dbNumber,
  input_tokens: dbNumber,
  output_tokens: dbNumber,
  last_used_at: dbDateOrNull,
});

export type SourceUsage = z.infer<typeof sourceUsageSchema>;

/**
 * Rolling 24-hour totals per upstream source — how hard each account is being
 * worked, and what it cost.
 *
 * Grouped on the `source_id`/`source_label` snapshot written onto the usage
 * row at settle time, not on the channel's current assignment: reassigning a
 * channel or renaming a source must not rewrite what history says was served.
 * Rows predating the snapshot migration carry a null source and are reported
 * under `(unknown)` rather than guessed at from today's configuration.
 */
export async function usageBySource24h(): Promise<SourceUsage[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT
      COALESCE(source_id, '(unknown)') AS source_id,
      COALESCE(source_label, '(unknown)') AS source_label,
      count(*) AS requests,
      count(*) FILTER (WHERE status <> 'ok') AS errors,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE status = 'ok')
        AS p95_latency_ms,
      COALESCE(SUM(credits_charged), 0) AS credits,
      COALESCE(SUM(cost_usd), 0) AS cost_usd,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      max(created_at) AS last_used_at
    FROM usage_events
    WHERE created_at >= now() - interval '24 hours'
    GROUP BY COALESCE(source_id, '(unknown)'), COALESCE(source_label, '(unknown)')
    ORDER BY COALESCE(SUM(cost_usd), 0) DESC, source_id ASC
  `;

  return rows.map((row) => sourceUsageSchema.parse(row));
}
