'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireAdmin, writeAudit } from '@/lib/api/admin';
import { parseUsdCents } from '@/lib/billing/catalog';
import { sql } from '@/lib/db';

import type { ActionState } from '../_components/action-state';

const field = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
};

/** "3" or "2.5" percent to basis points. */
const percent = z.string().trim().regex(/^\d{1,2}(?:\.\d{1,2})?$/, 'enter a percentage such as 3 or 2.5')
  .transform((value) => Math.round(Number(value) * 100))
  .refine((bps) => bps <= 5000, 'at most 50%');

const settingsSchema = z.object({
  enabled: z.boolean(),
  commission_bps: percent,
  bonus_bps: percent,
  hold_days: z.coerce.number().int('whole days only').min(0).max(180),
  window_days: z.string().trim().transform((value, ctx) => {
    if (value === '') return null;
    const days = Number(value);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      ctx.addIssue({ code: 'custom', message: 'earning window must be 1–3650 days, or empty for no limit' });
      return z.NEVER;
    }
    return days;
  }),
});

export async function updateReferralSettingsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = settingsSchema.safeParse({
      enabled: formData.get('enabled') === 'on',
      commission_bps: field(formData, 'commission'),
      bonus_bps: field(formData, 'bonus'),
      hold_days: field(formData, 'hold_days'),
      window_days: field(formData, 'window_days'),
    });
    if (!parsed.success) return { status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid input' };
    const next = parsed.data;
    await sql.begin(async (tx) => {
      const before = await tx`SELECT enabled, commission_bps, bonus_bps, hold_days, window_days FROM referral_settings FOR UPDATE`;
      const after = await tx`
        UPDATE referral_settings SET enabled = ${next.enabled}, commission_bps = ${next.commission_bps},
          bonus_bps = ${next.bonus_bps}, hold_days = ${next.hold_days}, window_days = ${next.window_days},
          updated_at = now(), updated_by = ${ctx.user.id}
        RETURNING enabled, commission_bps, bonus_bps, hold_days, window_days`;
      await writeAudit(ctx.user.id, 'referrals.settings', 'referral_settings', before[0], after[0], tx);
    });
    revalidatePath('/admin/referrals');
    return { status: 'success', message: 'settings saved; they apply to payments from now on' };
  } catch {
    return { status: 'error', message: 'could not save settings' };
  }
}

const referrerSchema = z.object({
  userId: z.uuid('invalid user id'),
  // Empty = use the program default.
  commission: z.string().trim().transform((value, ctx) => {
    if (value === '') return null;
    const result = percent.safeParse(value);
    if (!result.success) {
      ctx.addIssue({ code: 'custom', message: result.error.issues[0]?.message ?? 'invalid rate' });
      return z.NEVER;
    }
    return result.data;
  }),
  frozen: z.boolean(),
});

export async function updateReferrerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = referrerSchema.safeParse({
      userId: field(formData, 'userId'),
      commission: field(formData, 'commission'),
      frozen: formData.get('frozen') === 'on',
    });
    if (!parsed.success) return { status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid input' };
    const { userId, commission, frozen } = parsed.data;
    await sql.begin(async (tx) => {
      await tx`SELECT public.ensure_referral_account(${userId}::uuid)`;
      const before = await tx`SELECT code, commission_bps, frozen FROM referral_accounts WHERE user_id = ${userId} FOR UPDATE`;
      const after = await tx`
        UPDATE referral_accounts SET commission_bps = ${commission}, frozen = ${frozen}
        WHERE user_id = ${userId} RETURNING code, commission_bps, frozen`;
      await writeAudit(ctx.user.id, 'referrals.referrer', `user:${userId}`, before[0], after[0], tx);
    });
    revalidatePath(`/admin/users/${userId}`);
    revalidatePath('/admin/referrals');
    return { status: 'success', message: 'referrer updated' };
  } catch {
    return { status: 'error', message: 'could not update referrer' };
  }
}

const payoutSchema = z.object({
  userId: z.uuid('invalid user id'),
  credits: z.coerce.number().int('whole credits only').positive('credits must be positive').max(1_000_000_000),
  source: z.enum(['wallet', 'balance']),
  cash: z.string().trim(),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'use a 3-letter currency code'),
  method: z.string().trim().min(1, 'enter how it was paid').max(80),
  reference: z.string().trim().max(200),
  note: z.string().trim().max(500),
});

/**
 * Records a cash payout an admin has sent outside the app and removes the
 * matching referral credits. Users never see a cash option; only this page.
 */
export async function recordReferralPayoutAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = payoutSchema.safeParse(Object.fromEntries(
      ['userId', 'credits', 'source', 'cash', 'currency', 'method', 'reference', 'note'].map((name) => [name, field(formData, name)]),
    ));
    if (!parsed.success) return { status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid input' };
    const input = parsed.data;
    let cashCents: number;
    try {
      cashCents = parseUsdCents(input.cash);
    } catch {
      return { status: 'error', message: 'enter the cash amount sent, such as 12.50' };
    }
    await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT public.record_referral_cash_payout(${input.userId}::uuid, ${input.credits}, ${input.source}, ${cashCents},
          ${input.currency.toLowerCase()}, ${input.method}, ${input.reference}, ${input.note}, ${ctx.user.id}::uuid) AS payout`;
      await writeAudit(ctx.user.id, 'referrals.cash_payout', `user:${input.userId}`, null, rows[0]?.payout, tx);
    });
    revalidatePath(`/admin/users/${input.userId}`);
    revalidatePath('/admin/referrals');
    return { status: 'success', message: `recorded payout of ${input.credits.toLocaleString('en-US')} credits` };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const known = ['Payout exceeds the available rewards', 'Payout exceeds the referral credits transferred to the balance',
      'Payout exceeds the current balance', 'This user has no referral rewards'].find((text) => message.includes(text));
    return { status: 'error', message: known ?? 'payout failed' };
  }
}
