import { sql } from '@/lib/db';

export type OrderRow = { id: string; payment_id: string; user_id: string | null; email: string | null; kind: string; status: string; dispute_status: string; subtotal_cents: number; total_cents: number; credits_granted: number; credits_reversed: number; created_at: Date };

// Callers must authenticate. User history always passes the session owner's ID.
export async function orderHistory(input: { userId?: string; search?: string; kind?: string; disputed?: boolean; page: number }) {
  const search = '%' + (input.search ?? '').slice(0, 200) + '%';
  const where = sql`(${input.userId ?? null}::uuid IS NULL OR o.user_id=${input.userId ?? null}::uuid)
    AND (p.email ILIKE ${search} OR o.payment_id ILIKE ${search})
    AND (${input.kind ?? ''}='' OR o.kind=${input.kind ?? ''})
    AND (${input.disputed ?? false}=false OR o.dispute_status<>'none')`;
  const count = await sql`SELECT count(*)::int AS total FROM billing_orders o LEFT JOIN profiles p ON p.id=o.user_id WHERE ${where}`;
  const total = Number(count[0]!.total);
  const page = Math.min(Math.max(1, input.page), Math.max(1, Math.ceil(total / 25)));
  const rows = await sql<OrderRow[]>`SELECT o.*,p.email FROM billing_orders o LEFT JOIN profiles p ON p.id=o.user_id
    WHERE ${where} ORDER BY o.created_at DESC,o.id DESC LIMIT 25 OFFSET ${(page - 1) * 25}`;
  return { rows, total, page, pages: Math.max(1, Math.ceil(total / 25)) };
}

export type LeaderRow = { id: string; email: string; balance: number; topups: number; subscriptions: number; orders: number; plan: string; status: string; billing_hold: boolean };
export async function billingLeaderboard(sort: string, page: number) {
  const column = sort === 'topups' ? 'topups' : sort === 'subscriptions' ? 'subscriptions' : 'balance';
  return sql<LeaderRow[]>`WITH balances AS (SELECT user_id,sum(credits) AS balance FROM ledger GROUP BY user_id),
    purchases AS (SELECT user_id,
      coalesce(sum(credits_granted-credits_reversed) FILTER (WHERE kind='topup'),0) AS topups,
      coalesce(sum(credits_granted-credits_reversed) FILTER (WHERE kind='subscription'),0) AS subscriptions,
      count(*) AS orders FROM billing_orders GROUP BY user_id)
    SELECT p.id,p.email,p.billing_hold,coalesce(b.balance,0) AS balance,coalesce(o.topups,0) AS topups,
      coalesce(o.subscriptions,0) AS subscriptions,coalesce(o.orders,0) AS orders,
      coalesce(e.plan_key,'free') AS plan,coalesce(e.status,'inactive') AS status
    FROM profiles p LEFT JOIN balances b ON b.user_id=p.id LEFT JOIN purchases o ON o.user_id=p.id
      LEFT JOIN entitlements e ON e.user_id=p.id
    ORDER BY ${sql(column)} DESC,p.id LIMIT 26 OFFSET ${(page - 1) * 25}`;
}
