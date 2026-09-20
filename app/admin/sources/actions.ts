'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { FAMILIES } from '@/lib/ai/sources';
import { requireAdmin, writeAudit } from '@/lib/api/admin';
import { ApiError } from '@/lib/api/errors';
import { PLAN_KEYS } from '@/lib/billing/plans';
import { sql } from '@/lib/db';
import type { ActionState } from '../_components/action-state';

const schema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  family: z.enum(FAMILIES),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  creditMultiplier: z.coerce
    .number()
    .min(0.01)
    .max(99999999.99)
    .transform((n) => Math.round(n * 100) / 100),
  status: z.enum(['active', 'degraded', 'off']),
  minPlan: z.enum(PLAN_KEYS),
  isDefault: z
    .string()
    .optional()
    .transform((v) => v === 'on'),
});

function invalidate(): void {
  for (const path of [
    '/admin/sources',
    '/admin/channels',
    '/dashboard/routing',
    '/dashboard/models',
    '/prices',
  ])
    revalidatePath(path);
}

async function save(formData: FormData, creating: boolean): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = schema.safeParse(Object.fromEntries(formData));
    if (!parsed.success)
      return { status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid input' };
    const data = parsed.data;
    await sql.begin(async (tx) => {
      // Channel assignments share this lock, so the confirmed count cannot
      // change between inspection and repricing. Parameterized SQL stays local.
      await tx`SELECT pg_advisory_xact_lock(20260921)`;
      const before = (await tx`SELECT * FROM sources WHERE id = ${data.id} FOR UPDATE`)[0];
      if (creating && before) throw new ApiError('invalid_request', 'source already exists', 409);
      if (!creating && !before) throw new ApiError('not_found', 'source not found', 404);
      if (before && before.family !== data.family)
        throw new ApiError('invalid_request', 'Create a new source to change family.', 400);
      if (before && Number(before.credit_multiplier) !== data.creditMultiplier) {
        const counts =
          await tx`SELECT count(*)::int AS count FROM channels WHERE source_id = ${data.id}`;
        // A stale form must be reviewed again; confirmation includes old price
        // and count so another administrator cannot enlarge the approved change.
        if (
          formData.get('confirmReprice') !== 'on' ||
          Number(formData.get('affectedCount')) !== counts[0]?.count ||
          Number(formData.get('originalMultiplier')) !== Number(before.credit_multiplier)
        ) {
          throw new ApiError(
            'invalid_request',
            'Confirm the current multiplier and affected channel count; reload if they changed.',
            409,
          );
        }
      }
      if (data.isDefault) {
        const previous =
          await tx`SELECT * FROM sources WHERE family = ${data.family} AND is_default AND id <> ${data.id} FOR UPDATE`;
        for (const source of previous) {
          const after =
            await tx`UPDATE sources SET is_default = false, updated_at = now() WHERE id = ${source.id} RETURNING *`;
          await writeAudit(
            ctx.user.id,
            'source.default.clear',
            'source:' + source.id,
            source,
            after[0],
            tx,
          );
        }
      }
      const after = creating
        ? await tx`INSERT INTO sources (id,family,label,description,credit_multiplier,status,min_plan,is_default) VALUES (${data.id}, ${data.family}, ${data.label}, ${data.description}, ${data.creditMultiplier}, ${data.status}, ${data.minPlan}, ${data.isDefault}) RETURNING *`
        : await tx`UPDATE sources SET family=${data.family}, label=${data.label}, description=${data.description}, credit_multiplier=${data.creditMultiplier}, status=${data.status}, min_plan=${data.minPlan}, is_default=${data.isDefault}, updated_at=now() WHERE id=${data.id} RETURNING *`;
      await writeAudit(
        ctx.user.id,
        creating ? 'source.create' : 'source.update',
        'source:' + data.id,
        before ?? null,
        after[0],
        tx,
      );
    });
    invalidate();
    return { status: 'success', message: creating ? 'Source created' : 'Source updated' };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof ApiError ? err.message : 'Could not save source',
    };
  }
}

export async function createSourceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return save(formData, true);
}
export async function updateSourceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return save(formData, false);
}

export async function deleteSourceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const id = z.string().min(1).parse(formData.get('id'));
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(20260921)`;
      const before = (await tx`SELECT * FROM sources WHERE id = ${id} FOR UPDATE`)[0];
      if (!before) throw new ApiError('not_found', 'source not found', 404);
      const references =
        await tx`SELECT 1 FROM channels WHERE source_id=${id} UNION ALL SELECT 1 FROM user_routing_preferences WHERE source_id=${id} LIMIT 1`;
      if (references.length)
        throw new ApiError(
          'invalid_request',
          'Source is in use; disable it or reassign its channels and preferences first.',
          409,
        );
      await tx`DELETE FROM sources WHERE id=${id}`;
      await writeAudit(ctx.user.id, 'source.delete', 'source:' + id, before, null, tx);
    });
    invalidate();
    return { status: 'success', message: 'Source deleted' };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof ApiError ? err.message : 'Could not delete source',
    };
  }
}
