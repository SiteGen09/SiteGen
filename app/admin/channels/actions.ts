'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireAdmin, writeAudit } from '@/lib/api/admin';
import { ApiError } from '@/lib/api/errors';
import { sql } from '@/lib/db';
import { isPlanKey, type PlanKey } from '@/lib/billing/plans';
import {
  acceptsBaseUrl,
  PROVIDERS,
  PROVIDER_LABELS,
  requiresBaseUrl,
  type Provider,
} from '@/lib/ai/providers';

import type { ActionState } from '../_components/action-state';

const TASKS = ['site.spec', 'site.copy', 'interview', 'chat.completions'] as const;
const STATUSES = ['active', 'degraded', 'off'] as const;

/**
 * USD per million tokens. Bounded to six decimals because the column is
 * `numeric(12,6)` — anything finer would be rounded on write and not
 * round-trip, so the stored value stays the one the admin sees.
 */
function rate(label: string) {
  return z.coerce
    .number()
    .refine(Number.isFinite, `${label} must be a number`)
    .refine((n) => n >= 0, `${label} must be >= 0`)
    .transform((n) => Math.round(n * 1_000_000) / 1_000_000);
}

/**
 * Public model name callers pass as `"model"`. Null for channels that are not
 * addressable by name, e.g. everything on the site-spec path.
 */
const publicModelId = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : v))
  .refine((v) => v === null || v.length <= 128, 'public model id must be <= 128 characters');

const baseFields = {
  label: z.string().trim().min(1, 'label is required').max(120),
  task: z.enum(TASKS),
  provider: z.enum(PROVIDERS),
  baseUrl: z
    .string()
    .trim()
    .transform((v) => (v.length === 0 ? null : v)),
  modelId: z.string().trim().min(1, 'model id is required').max(200),
  publicModelId,
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
  inputPerMTok: rate('input rate'),
  outputPerMTok: rate('output rate'),
  cachedPerMTok: rate('cached rate'),
};

/**
 * A channel's base URL decides which host it calls, and — with its provider —
 * which stored credential it resolves. A compatible gateway needs one;
 * `anthropic` must not have one, because the first-party client ignores it and
 * the channel would then match no credential at all.
 */
function checkBaseUrl(
  value: { provider: Provider; baseUrl: string | null },
  ctx: z.RefinementCtx,
): void {
  if (requiresBaseUrl(value.provider) && value.baseUrl === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['baseUrl'],
      message: `${PROVIDER_LABELS[value.provider]} requires a base URL`,
    });
  }
  if (!acceptsBaseUrl(value.provider) && value.baseUrl !== null) {
    ctx.addIssue({
      code: 'custom',
      path: ['baseUrl'],
      message:
        'anthropic always calls api.anthropic.com — choose anthropic_compatible to use a gateway',
    });
  }
}

const createSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]{1,64}$/, 'id must be lowercase letters, digits and hyphens'),
    ...baseFields,
  })
  .superRefine(checkBaseUrl);

const updateSchema = z
  .object({ id: z.string().trim().min(1), ...baseFields })
  .superRefine(checkBaseUrl);

function formValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    'id',
    'label',
    'task',
    'provider',
    'baseUrl',
    'modelId',
    'publicModelId',
    'creditMultiplier',
    'status',
    'minPlan',
    'fallbackTo',
    'priority',
    'inputPerMTok',
    'outputPerMTok',
    'cachedPerMTok',
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
      if (data.publicModelId !== null) {
        const clash = await tx<{ one: number }[]>`
          SELECT 1 AS one FROM channels WHERE public_model_id = ${data.publicModelId}
        `;
        if (clash[0] !== undefined) {
          throw new ApiError(
            'invalid_request',
            `public model id '${data.publicModelId}' is already in use`,
            409,
          );
        }
      }

      const rows = await tx`
        INSERT INTO channels
          (id, label, task, provider, base_url, model_id, public_model_id,
           credit_multiplier, status, min_plan, fallback_to, priority,
           input_per_mtok, output_per_mtok, cached_per_mtok)
        VALUES (
          ${data.id}, ${data.label}, ${data.task}, ${data.provider}, ${data.baseUrl},
          ${data.modelId}, ${data.publicModelId},
          ${toMultiplier(data.creditMultiplier)}, ${data.status},
          ${data.minPlan}, ${data.fallbackTo}, ${data.priority},
          ${data.inputPerMTok}, ${data.outputPerMTok}, ${data.cachedPerMTok}
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
      if (data.publicModelId !== null) {
        const clash = await tx<{ id: string }[]>`
          SELECT id FROM channels
          WHERE public_model_id = ${data.publicModelId} AND id <> ${data.id}
        `;
        if (clash[0] !== undefined) {
          throw new ApiError(
            'invalid_request',
            `public model id '${data.publicModelId}' is already in use`,
            409,
          );
        }
      }

      const afterRows = await tx`
        UPDATE channels SET
          label = ${data.label},
          task = ${data.task},
          provider = ${data.provider},
          base_url = ${data.baseUrl},
          model_id = ${data.modelId},
          public_model_id = ${data.publicModelId},
          credit_multiplier = ${toMultiplier(data.creditMultiplier)},
          status = ${data.status},
          min_plan = ${data.minPlan},
          fallback_to = ${data.fallbackTo},
          priority = ${data.priority},
          input_per_mtok = ${data.inputPerMTok},
          output_per_mtok = ${data.outputPerMTok},
          cached_per_mtok = ${data.cachedPerMTok},
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