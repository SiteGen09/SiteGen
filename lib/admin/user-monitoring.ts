import type { Sql, TransactionSql } from 'postgres';
import { z } from 'zod';

import { sql } from '@/lib/db';

type Connection = Sql | TransactionSql;

const number = z.coerce.number().finite();

const accountSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
  status: z.string(),
  billing_hold: z.boolean(),
  created_at: z.coerce.date(),
  plan_key: z.string().nullable(),
  entitlement_status: z.string().nullable(),
  current_period_end: z.coerce.date().nullable(),
  monthly_credits: number.nullable(),
  balance: number,
  reserved: number,
  strikes_24h: number,
  last_used_at: z.coerce.date().nullable(),
});

export type UserAccount = z.infer<typeof accountSchema>;

/**
 * One account's profile, entitlement and credit position, for the admin user
 * detail page. Admin-only, called after requireAdmin.
 *
 * Balance and reserved come from one pass over the user's ledger. Reserved is
 * what open holds keep back from in-flight requests: a hold writes -N and its
 * settle or release writes +N back, so hold and release rows net to zero once
 * a request finishes. Balance already has holds subtracted.
 */
export async function userAccount(
  userId: string,
  connection: Connection = sql,
): Promise<UserAccount | null> {
  const rows = await connection<Record<string, unknown>[]>`
    SELECT p.id, p.email, p.role, p.status, p.billing_hold, p.created_at,
      e.plan_key, e.status AS entitlement_status, e.current_period_end, e.monthly_credits,
      COALESCE(l.balance, 0) AS balance,
      COALESCE(l.reserved, 0) AS reserved,
      (SELECT count(*) FROM abuse_strikes s
        WHERE s.user_id = p.id AND s.created_at >= now() - interval '24 hours') AS strikes_24h,
      (SELECT max(u.created_at) FROM usage_events u WHERE u.user_id = p.id) AS last_used_at
    FROM profiles p
    LEFT JOIN entitlements e ON e.user_id = p.id
    LEFT JOIN LATERAL (
      SELECT sum(credits) AS balance,
        -sum(credits) FILTER (WHERE kind IN ('hold', 'release')) AS reserved
      FROM ledger WHERE user_id = p.id
    ) l ON true
    WHERE p.id = ${userId}
  `;
  const row = rows[0];
  return row === undefined ? null : accountSchema.parse(row);
}

const creditEntrySchema = z.object({
  id: number,
  kind: z.string(),
  credits: number,
  request_id: z.string(),
  reason: z.string().nullable(),
  created_at: z.coerce.date(),
});

export type CreditEntry = z.infer<typeof creditEntrySchema>;

/**
 * Credits added to or taken back from an account: top-ups, grants, refunds.
 * Hold, release and settle rows are left out because every request writes
 * them; per-request charges are listed with the request instead.
 */
export async function userCreditHistory(
  userId: string,
  limit: number,
  connection: Connection = sql,
): Promise<CreditEntry[]> {
  const rows = await connection<Record<string, unknown>[]>`
    SELECT id, kind, credits, request_id, meta->>'reason' AS reason, created_at
    FROM ledger
    WHERE user_id = ${userId} AND kind NOT IN ('hold', 'release', 'settle')
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => creditEntrySchema.parse(row));
}
