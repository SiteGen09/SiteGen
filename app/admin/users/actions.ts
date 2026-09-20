'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireAdmin, writeAudit } from '@/lib/api/admin';
import { ApiError } from '@/lib/api/errors';
import { sql } from '@/lib/db';

import type { ActionState } from '../_components/action-state';

const MAX_GRANT = 10_000_000;

const grantSchema = z.object({
  userId: z.string().uuid('invalid user id'),
  amount: z.coerce
    .number()
    .int('amount must be a whole number of credits')
    .refine((n) => n > 0, 'amount must be positive')
    .refine((n) => n <= MAX_GRANT, `amount must be <= ${MAX_GRANT}`),
  reason: z.string().trim().min(1, 'a reason is required').max(500),
});

const statusSchema = z.object({
  userId: z.string().uuid('invalid user id'),
  reason: z.string().trim().min(1, 'a reason is required').max(500),
});

/**
 * Flips `profiles.status`. Suspension is enforced inside `authenticateApiKey`,
 * so this takes effect on the account's very next API call without revoking
 * keys or deleting the auth user.
 */
async function setStatusAction(
  formData: FormData,
  next: 'active' | 'suspended',
): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = statusSchema.safeParse({
      userId: typeof formData.get('userId') === 'string' ? formData.get('userId') : '',
      reason: typeof formData.get('reason') === 'string' ? formData.get('reason') : '',
    });
    if (!parsed.success) {
      return { status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid input' };
    }
    const { userId, reason } = parsed.data;

    await sql.begin(async (tx) => {
      const rows = await tx`
        SELECT id, email, status FROM profiles WHERE id = ${userId} FOR UPDATE
      `;
      const before = rows[0];
      if (before === undefined) {
        throw new ApiError('not_found', 'user not found', 404);
      }

      const after = await tx`
        UPDATE profiles SET status = ${next} WHERE id = ${userId} RETURNING id, email, status
      `;
      await writeAudit(
        ctx.user.id,
        `user.${next === 'suspended' ? 'suspend' : 'unsuspend'}`,
        `user:${userId}`,
        before,
        { ...after[0], reason },
        tx,
      );
    });

    revalidatePath('/admin/users');
    return {
      status: 'success',
      message: next === 'suspended' ? 'user suspended' : 'user unsuspended',
    };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof ApiError ? err.message : 'status change failed',
    };
  }
}

export async function suspendUserAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return setStatusAction(formData, 'suspended');
}

export async function unsuspendUserAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return setStatusAction(formData, 'active');
}

export async function grantCreditsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = grantSchema.safeParse({
      userId: typeof formData.get('userId') === 'string' ? formData.get('userId') : '',
      amount: typeof formData.get('amount') === 'string' ? formData.get('amount') : '',
      reason: typeof formData.get('reason') === 'string' ? formData.get('reason') : '',
    });
    if (!parsed.success) {
      return { status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid input' };
    }
    const { userId, amount, reason } = parsed.data;
    const requestId = `admin-grant-${randomUUID()}`;
    const meta = JSON.stringify({ reason, actor_id: ctx.user.id });

    await sql.begin(async (tx) => {
      const user = await tx<{ one: number }[]>`SELECT 1 AS one FROM profiles WHERE id = ${userId}`;
      if (user[0] === undefined) {
        throw new ApiError('not_found', 'user not found', 404);
      }
      const rows = await tx`
        INSERT INTO ledger (user_id, request_id, kind, credits, meta)
        VALUES (${userId}, ${requestId}, 'grant', ${amount}, ${meta}::jsonb)
        RETURNING *
      `;
      await writeAudit(ctx.user.id, 'credits.grant', `user:${userId}`, null, rows[0], tx);
    });

    revalidatePath('/admin/users');
    return { status: 'success', message: `granted ${amount.toLocaleString()} credits` };
  } catch (err) {
    return { status: 'error', message: err instanceof ApiError ? err.message : 'grant failed' };
  }
}
