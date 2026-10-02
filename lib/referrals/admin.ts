import { z } from 'zod';
import { sql } from '@/lib/db';
import { settingsSchema, walletSchema, type ReferralSettings, type ReferralWallet } from './referrals';

const time = z.coerce.date();

export async function referralSettings(): Promise<ReferralSettings & { updated_at: Date }> {
  const rows = await sql`SELECT enabled, commission_bps, bonus_bps, hold_days, window_days, updated_at FROM referral_settings`;
  return settingsSchema.extend({ updated_at: time }).parse(rows[0]);
}

const payoutSchema = z.object({
  id: z.coerce.number(),
  user_id: z.string(),
  email: z.string().nullable(),
  source: z.enum(['wallet', 'balance']),
  credits: z.coerce.number(),
  cash_cents: z.coerce.number(),
  cash_currency: z.string().nullable(),
  method: z.string(),
  reference: z.string().nullable(),
  note: z.string().nullable(),
  actor_email: z.string().nullable(),
  created_at: time,
});
export type ReferralPayout = z.infer<typeof payoutSchema>;

export async function referralPayouts(options: { userId?: string; limit?: number } = {}): Promise<ReferralPayout[]> {
  const rows = await sql`
    SELECT m.id, m.user_id, p.email, m.source, m.credits, m.cash_cents, m.cash_currency, m.method, m.reference,
           m.note, a.email AS actor_email, m.created_at
    FROM referral_wallet_moves m
    LEFT JOIN profiles p ON p.id = m.user_id
    LEFT JOIN profiles a ON a.id = m.actor_id
    WHERE m.kind = 'cash_payout' ${options.userId === undefined ? sql`` : sql`AND m.user_id = ${options.userId}`}
    ORDER BY m.created_at DESC
    LIMIT ${options.limit ?? 50}
  `;
  return z.array(payoutSchema).parse(rows);
}

const referrerSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  code: z.string(),
  commission_bps: z.number().int().nullable(),
  frozen: z.boolean(),
  invites: z.coerce.number(),
  paying: z.coerce.number(),
  total_earned: z.coerce.number(),
  paid_out: z.coerce.number(),
});
export type Referrer = z.infer<typeof referrerSchema>;

/** Referrers with at least one invite, most earned first. */
export async function topReferrers(limit = 50): Promise<Referrer[]> {
  const rows = await sql`
    SELECT a.user_id, p.email, a.code, a.commission_bps, a.frozen,
      (SELECT count(*) FROM referrals r WHERE r.referrer_id = a.user_id) AS invites,
      (SELECT count(DISTINCT c.referred_id) FROM referral_commissions c WHERE c.referrer_id = a.user_id AND c.credits > 0) AS paying,
      (SELECT COALESCE(sum(c.credits), 0) FROM referral_commissions c WHERE c.referrer_id = a.user_id) AS total_earned,
      (SELECT COALESCE(sum(m.credits), 0) FROM referral_wallet_moves m WHERE m.user_id = a.user_id AND m.kind = 'cash_payout') AS paid_out
    FROM referral_accounts a
    JOIN profiles p ON p.id = a.user_id
    WHERE EXISTS (SELECT 1 FROM referrals r WHERE r.referrer_id = a.user_id)
    ORDER BY total_earned DESC, invites DESC
    LIMIT ${limit}
  `;
  return z.array(referrerSchema).parse(rows);
}

const invitedSchema = z.object({
  referred_id: z.string(),
  email: z.string().nullable(),
  created_at: time,
  earned: z.coerce.number(),
});
const commissionSchema = z.object({
  payment_id: z.string(),
  email: z.string().nullable(),
  order_kind: z.string(),
  base_cents: z.coerce.number(),
  rate_bps: z.number().int(),
  full_credits: z.coerce.number(),
  credits: z.coerce.number(),
  available_at: time,
  created_at: time,
});

export interface UserReferralPanel {
  account: { code: string; commission_bps: number | null; frozen: boolean } | null;
  referredBy: { user_id: string; email: string | null; code: string; created_at: Date; bonus_credits: number } | null;
  wallet: ReferralWallet;
  invited: z.infer<typeof invitedSchema>[];
  commissions: z.infer<typeof commissionSchema>[];
  payouts: ReferralPayout[];
}

export async function userReferralPanel(userId: string): Promise<UserReferralPanel> {
  const [account, referredBy, wallet, invited, commissions, payouts] = await Promise.all([
    sql`SELECT code, commission_bps, frozen FROM referral_accounts WHERE user_id = ${userId}`,
    sql`SELECT r.referrer_id AS user_id, p.email, r.code, r.created_at, r.bonus_credits
        FROM referrals r LEFT JOIN profiles p ON p.id = r.referrer_id WHERE r.referred_id = ${userId}`,
    sql`SELECT public.referral_wallet(${userId}::uuid) AS wallet`,
    sql`SELECT r.referred_id, p.email, r.created_at,
          (SELECT COALESCE(sum(c.credits), 0) FROM referral_commissions c WHERE c.referred_id = r.referred_id AND c.referrer_id = ${userId}) AS earned
        FROM referrals r LEFT JOIN profiles p ON p.id = r.referred_id
        WHERE r.referrer_id = ${userId} ORDER BY r.created_at DESC LIMIT 50`,
    sql`SELECT c.payment_id, p.email, c.order_kind, c.base_cents, c.rate_bps, c.full_credits, c.credits, c.available_at, c.created_at
        FROM referral_commissions c LEFT JOIN profiles p ON p.id = c.referred_id
        WHERE c.referrer_id = ${userId} ORDER BY c.created_at DESC LIMIT 50`,
    referralPayouts({ userId, limit: 25 }),
  ]);
  return {
    account: account[0] === undefined ? null
      : z.object({ code: z.string(), commission_bps: z.number().int().nullable(), frozen: z.boolean() }).parse(account[0]),
    referredBy: referredBy[0] === undefined ? null : z.object({
      user_id: z.string(), email: z.string().nullable(), code: z.string(), created_at: time, bonus_credits: z.coerce.number(),
    }).parse(referredBy[0]),
    wallet: walletSchema.parse(wallet[0]?.wallet),
    invited: z.array(invitedSchema).parse(invited),
    commissions: z.array(commissionSchema).parse(commissions),
    payouts,
  };
}
