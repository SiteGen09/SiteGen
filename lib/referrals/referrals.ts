import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/log';
import { normalizeReferralCode } from './code';

const log = logger({ component: 'referrals' });

export const walletSchema = z.object({
  pending: z.coerce.number(),
  available: z.coerce.number(),
  total_earned: z.coerce.number(),
  transferred: z.coerce.number(),
  paid_out: z.coerce.number(),
  reclaimable: z.coerce.number(),
  invites: z.coerce.number(),
});
export type ReferralWallet = z.infer<typeof walletSchema>;

export const settingsSchema = z.object({
  enabled: z.boolean(),
  commission_bps: z.number().int(),
  bonus_bps: z.number().int(),
  hold_days: z.number().int(),
  window_days: z.number().int().nullable(),
});
export type ReferralSettings = z.infer<typeof settingsSchema>;

export type ClaimResult = 'ok' | 'invalid_code' | 'disabled' | 'unknown_user' | 'already_referred' | 'self_referral' | 'too_late';

/**
 * Attach a just-created account to the referrer who owns `code`. Never
 * throws: a referral problem must not get in the way of signing up.
 */
export async function claimReferral(userId: string, code: unknown): Promise<ClaimResult | 'error'> {
  const normalized = normalizeReferralCode(code);
  if (normalized === null) return 'invalid_code';
  try {
    const { data, error } = await createServiceClient().rpc('claim_referral', { p_user: userId, p_code: normalized });
    if (error) throw new Error(error.message);
    const result = z.enum(['ok', 'invalid_code', 'disabled', 'unknown_user', 'already_referred', 'self_referral', 'too_late']).parse(data);
    if (result === 'ok') log.info('referral.claimed', { user_id: userId, code: normalized });
    return result;
  } catch (error) {
    log.error('referral.claim_failed', { user_id: userId, error: error instanceof Error ? error.message : String(error) });
    return 'error';
  }
}

export interface ReferralActivity {
  id: string;
  at: string;
  label: string;
  credits: number;
  status: 'pending' | 'available' | 'reversed' | 'partially_reversed' | 'done';
}

export interface ReferralOverview {
  code: string;
  rateBps: number;
  bonusBps: number;
  holdDays: number;
  enabled: boolean;
  frozen: boolean;
  wallet: ReferralWallet;
  activity: ReferralActivity[];
}

const commissionRow = z.object({
  payment_id: z.string(),
  order_kind: z.string(),
  full_credits: z.coerce.number(),
  credits: z.coerce.number(),
  available_at: z.string(),
  created_at: z.string(),
});
const moveRow = z.object({
  id: z.coerce.string(),
  kind: z.enum(['transfer', 'cash_payout']),
  credits: z.coerce.number(),
  created_at: z.string(),
});

/** Everything the dashboard referral page shows. Creates the code on first visit. */
export async function referralOverview(userId: string): Promise<ReferralOverview> {
  const service = createServiceClient();
  const codeResult = await service.rpc('ensure_referral_account', { p_user: userId });
  if (codeResult.error) throw new Error('Referral code unavailable: ' + codeResult.error.message);
  const [wallet, settings, account, commissions, moves] = await Promise.all([
    service.rpc('referral_wallet', { p_user: userId }),
    service.from('referral_settings').select('enabled, commission_bps, bonus_bps, hold_days, window_days').single(),
    service.from('referral_accounts').select('commission_bps, frozen').eq('user_id', userId).single(),
    service.from('referral_commissions').select('payment_id, order_kind, full_credits, credits, available_at, created_at')
      .eq('referrer_id', userId).order('created_at', { ascending: false }).limit(20),
    service.from('referral_wallet_moves').select('id, kind, credits, created_at')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
  ]);
  for (const result of [wallet, settings, account, commissions, moves]) {
    if (result.error) throw new Error('Referral data unavailable: ' + result.error.message);
  }
  const config = settingsSchema.parse(settings.data);
  const own = z.object({ commission_bps: z.number().int().nullable(), frozen: z.boolean() }).parse(account.data);
  const now = Date.now();
  const activity: ReferralActivity[] = [
    ...z.array(commissionRow).parse(commissions.data).map((row): ReferralActivity => ({
      id: 'c:' + row.payment_id,
      at: row.created_at,
      label: row.order_kind === 'subscription' ? 'Referral subscription payment' : 'Referral top-up',
      credits: row.credits,
      status: row.credits === 0 ? 'reversed'
        : row.credits < row.full_credits ? 'partially_reversed'
        : Date.parse(row.available_at) > now ? 'pending' : 'available',
    })),
    ...z.array(moveRow).parse(moves.data).map((row): ReferralActivity => ({
      id: 'm:' + row.id,
      at: row.created_at,
      label: row.kind === 'transfer' ? 'Transferred to balance' : 'Reward payout (processed by support)',
      credits: -row.credits,
      status: 'done',
    })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 20);

  return {
    code: z.string().parse(codeResult.data),
    rateBps: own.commission_bps ?? config.commission_bps,
    bonusBps: config.bonus_bps,
    holdDays: config.hold_days,
    enabled: config.enabled,
    frozen: own.frozen,
    wallet: walletSchema.parse(wallet.data),
    activity,
  };
}

/** Moves every unlocked reward into the user's balance. Returns credits moved. */
export async function transferReferralRewards(userId: string): Promise<number> {
  const { data, error } = await createServiceClient().rpc('transfer_referral_rewards', { p_user: userId });
  if (error) {
    log.warn('referral.transfer_failed', { user_id: userId, error: error.message });
    throw new Error(error.message.includes('not available') ? 'Referral rewards are not available for this account.' : 'Could not transfer rewards. Try again.');
  }
  return z.coerce.number().parse(data);
}

export function formatRate(bps: number): string {
  return (bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
}
