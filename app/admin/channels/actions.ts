'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireAdmin, writeAudit } from '@/lib/api/admin';
import { ApiError } from '@/lib/api/errors';
import { sql } from '@/lib/db';
import { isPlanKey, type PlanKey } from '@/lib/billing/plans';

import type { ActionState } from '../_components/action-state';

const TASKS = ['site.spec', 'site.copy', 'interview'] as const;
const PROVIDERS = ['anthropic', 'openai_compatible'] as const;
const STATUSES = ['active', 'degraded', 'off'] as const;

const baseFields = {
  label: z.string().trim().min(1, 'label is required').max(120),
  task: z.enum(TASKS),
  provider: z.enum(PROVIDERS),
  baseUrl: z
    .string()
    .trim()
    .transform((v) => (v.length === 0 ? null : v)),
  modelId: z.string().trim().min(1, 'model id is required').max(200),
  creditMultiplier: z.coerce
    .number()
    .refine(Number.isFinite, 'multiplier must be a number')
    .refine((n) => n >= 0, 'multiplier must be >= 0'),
  status: z.enum(STATUSES),
  minPlan: z
    .string()
    .refine((v): v is PlanKey => isPlanKey(v), 'invalid plan'),
  fallbackTo: z
    .string()
    .trim()
    .transform((v) => (v.length === 0 ? null : v)),
  priority: z.coerce.number().int('priority must be an integer'),
};

const createSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{1,64}$/, 'id must be lowercase letters, digits and hyphens'),
    ...baseFields,
  })
  .refine((v) => v.provider !== 'openai_compatible' || v.baseUrl !== null, {
    message: 'openai_compatible requires a base URL',
    path: ['baseUrl'],
  });

const updateSchema = z
  .object({ id: z.string().trim().min(1), ...baseFields })
  .refine((v) => v.provider !== 'openai_compatible' || v.baseUrl !== null, {
    message: 'openai_compatible requires a base URL',
    path: ['baseUrl'],
  });

function formValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    'id',
    'label',
    'task',
    'provider',
    'baseUrl',
    'modelId',
    'creditMultiplier',
    'status',
    'minPlan',
    'fallbackTo',
    'priority',
  ]) {
    const value = formData.get(key);
    out[key] = typeof value === 'string' ? value : '';
  }
  return out;
}

/** numeric(10,2) column — clamp to two decimals so we store what admins see. */
function toMultiplier(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function createChannelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = createSchema.safeParse(formValues(formData));
    if (!parsed.success) {
      return { status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid input' };
    }
    const data = parsed.data;

    if (data.fallbackTo === data.id) {
      return { status: 'error', message: 'fallback cannot reference the channel itself' };
    }

    await sql.begin(async (tx) => {
      const dupe = await tx<{ one: number }[]>`SELECT 1 AS one FROM channels WHERE id = ${data.id}`;
      if (dupe[0] !== undefined) {
        throw new ApiError('invalid_request', `channel '${data.id}' already exists`, 409);
      }
      if (data.fallbackTo !== null) {
        const fb = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM channels WHERE id = ${data.fallbackTo}
        `;
        if (fb[0] === undefined) {
          throw new ApiError('invalid_request', `fallback '${data.fallbackTo}' does not exist`, 400);
        }
      }

      const rows = await tx`
        INSERT INTO channels
          (id, label, task, provider, base_url, model_id, credit_multiplier,
           status, min_plan, fallback_to, priority)
        VALUES (
          ${data.id}, ${data.label}, ${data.task}, ${data.provider}, ${data.baseUrl},
          ${data.modelId}, ${toMultiplier(data.creditMultiplier)}, ${data.status},
          ${data.minPlan}, ${data.fallbackTo}, ${data.priority}
        )
        RETURNING *
      `;
      await writeAudit(ctx.user.id, 'channel.create', `channel:${data.id}`, null, rows[0], tx);
    });

    revalidatePath('/admin/channels');
    return { status: 'success', message: `channel '${data.id}' created` };
  } catch (err) {
    return { status: 'error', message: err instanceof ApiError ? err.message : 'create failed' };
  }
}

export async function updateChannelAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = updateSchema.safeParse(formValues(formData));
    if (!parsed.success) {
      return { status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid input' };
    }
    const data = parsed.data;

    if (data.fallbackTo === data.id) {
      return { status: 'error', message: 'fallback cannot reference the channel itself' };
    }

    await sql.begin(async (tx) => {
      const beforeRows = await tx`SELECT * FROM channels WHERE id = ${data.id} FOR UPDATE`;
      const before = beforeRows[0];
      if (before === undefined) {
        throw new ApiError('not_found', `channel '${data.id}' not found`, 404);
      }

      if (data.fallbackTo !== null) {
        const target = await tx<{ id: string }[]>`
          SELECT id FROM channels WHERE id = ${data.fallbackTo}
        `;
        if (target[0] === undefined) {
          throw new ApiError('invalid_request', `fallback '${data.fallbackTo}' does not exist`, 400);
        }
      }

      const afterRows = await tx`
        UPDATE channels SET
          label = ${data.label},
          task = ${data.task},
          provider = ${data.provider},
          base_url = ${data.baseUrl},
          model_id = ${data.modelId},
          credit_multiplier = ${toMultiplier(data.creditMultiplier)},
          status = ${data.status},
          min_plan = ${data.minPlan},
          fallback_to = ${data.fallbackTo},
          priority = ${data.priority},
          updated_at = now()
        WHERE id = ${data.id}
        RETURNING *
      `;
      await writeAudit(ctx.user.id, 'channel.update', `channel:${data.id}`, before, afterRows[0], tx);
    });

    revalidatePath('/admin/channels');
    return { status: 'success', message: `channel '${data.id}' updated` };
  } catch (err) {
    return { status: 'error', message: err instanceof ApiError ? err.message : 'update failed' };
  }
}

/** Flips a channel between `active` and `off`. Degraded channels are set to off. */
export async function toggleChannelAction(formData: FormData): Promise<void> {
  const ctx = await requireAdmin();
  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) {
    throw new ApiError('invalid_request', 'missing channel id', 400);
  }

  await sql.begin(async (tx) => {
    const beforeRows = await tx`SELECT * FROM channels WHERE id = ${id} FOR UPDATE`;
    const before = beforeRows[0];
    if (before === undefined) {
      throw new ApiError('not_found', `channel '${id}' not found`, 404);
    }
    const next = before.status === 'active' ? 'off' : 'active';
    const afterRows = await tx`
      UPDATE channels SET status = ${next}, updated_at = now() WHERE id = ${id} RETURNING *
    `;
    await writeAudit(ctx.user.id, 'channel.toggle', `channel:${id}`, before, afterRows[0], tx);
  });

  revalidatePath('/admin/channels');
}
