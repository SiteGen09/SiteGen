'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireAdmin, writeAudit } from '@/lib/api/admin';
import { sql } from '@/lib/db';
import { ApiError } from '@/lib/api/errors';
import { createRedemptionCode, MAX_CODE_REDEMPTIONS, MAX_REDEMPTION_CREDITS } from '@/lib/billing/redemption';
import type { ActionState } from '../_components/action-state';

const createSchema = z.object({
  credits: z.coerce.number().int().positive().max(MAX_REDEMPTION_CREDITS),
  maxRedemptions: z.coerce.number().int().positive().max(MAX_CODE_REDEMPTIONS),
  expiresAt: z.string().trim().max(40),
  label: z.string().trim().max(120),
});

export async function createRedemptionCodeAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = createSchema.safeParse({
      credits: formData.get('credits'),
      maxRedemptions: formData.get('maxRedemptions'),
      expiresAt: typeof formData.get('expiresAt') === 'string' ? formData.get('expiresAt') : '',
      label: typeof formData.get('label') === 'string' ? formData.get('label') : '',
    });
    if (!parsed.success) return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Invalid code settings.' };
    const created = await createRedemptionCode({
      createdBy: ctx.user.id,
      credits: parsed.data.credits,
      maxRedemptions: parsed.data.maxRedemptions,
      expiresAt: parsed.data.expiresAt ? parsed.data.expiresAt + 'Z' : null,
      label: parsed.data.label || null,
    });
    revalidatePath('/admin/redemption-codes');
    return { status: 'success', message: `Created ${created.code}. Copy it now; the full code is not stored or shown again.` };
  } catch (error) {
    return { status: 'error', message: error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Could not create code.' };
  }
}

export async function revokeRedemptionCode(form: FormData): Promise<void> {
  const ctx = await requireAdmin();
  const id = z.uuid().parse(form.get('id'));
  await sql.begin(async (tx) => {
    const rows = await tx`SELECT active FROM credit_redemption_codes WHERE id=${id} FOR UPDATE`;
    if (!rows[0]?.active) return;
    await tx`UPDATE credit_redemption_codes SET active=false,updated_at=now() WHERE id=${id}`;
    await writeAudit(ctx.user.id, 'credits.redemption_code.revoke', 'redemption_code:' + id, {active:true}, {active:false}, tx);
  });
  revalidatePath('/admin/redemption-codes');
}
