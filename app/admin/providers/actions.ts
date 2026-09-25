'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isProviderReprice, listProviderPricing } from '@/lib/admin/provider-pricing';
import { requireAdmin, writeAudit } from '@/lib/api/admin';
import { ApiError } from '@/lib/api/errors';
import { sql } from '@/lib/db';
import type { ActionState } from '../_components/action-state';

const schema = z.object({
  id: z.string().min(1).max(255),
  label: z.string().trim().max(60, 'Keep the display name to 60 characters.'),
  creditMultiplier: z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (value === '') return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0.01 || n > 99999999.99) {
        ctx.addIssue({ code: 'custom', message: 'Enter a multiplier from 0.01.' });
        return z.NEVER;
      }
      return Math.round(n * 100) / 100;
    }),
  fingerprint: z.string(),
});

function invalidate(): void {
  for (const path of [
    '/admin/providers',
    '/admin/sources',
    '/admin/channels',
    '/dashboard/routing',
    '/dashboard/models',
    '/dashboard/usage',
    '/prices',
  ])
    revalidatePath(path);
}

/** Reprices every source of one provider and sets its public display name. */
export async function saveProviderAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = schema.safeParse(Object.fromEntries(formData));
    if (!parsed.success)
      return { status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid input' };
    const data = parsed.data;
    const label = data.label === '' ? null : data.label;
    let repriced = 0;
    await sql.begin(async (tx) => {
      // Admin source and channel edits share the advisory lock. The table lock
      // makes a concurrent catalog import wait, so a source it adds cannot miss
      // both this update and the new provider-wide price.
      await tx`SELECT pg_advisory_xact_lock(20260921)`;
      await tx`LOCK TABLE sources IN SHARE ROW EXCLUSIVE MODE`;
      const all = await listProviderPricing(tx);
      const provider = all.find((item) => item.id === data.id);
      if (!provider) throw new ApiError('not_found', 'provider not found', 404);

      const effective = (item: (typeof all)[number]) => item.label ?? item.defaultLabel;
      const taken = label?.toLocaleLowerCase();
      if (
        taken === 'byok' ||
        all.some((item) => item.id !== provider.id && effective(item).toLocaleLowerCase() === taken)
      )
        throw new ApiError('invalid_request', `Another provider is already named "${label}".`, 409);

      const reprice = isProviderReprice(provider, data.creditMultiplier);
      // A stale form must be reviewed again: the confirmation covered exactly
      // these sources at these prices, so a source added or repriced since
      // cannot be swept into the change unseen.
      if (reprice && (formData.get('confirmReprice') !== 'on' || data.fingerprint !== provider.fingerprint))
        throw new ApiError(
          'invalid_request',
          'Confirm the reprice; if this provider changed since the page loaded, reload and review it again.',
          409,
        );

      const before = (await tx`SELECT * FROM routing_providers WHERE id = ${provider.id}`)[0] ?? null;
      const managed = reprice ? data.creditMultiplier : provider.managedMultiplier;
      const after = (
        await tx`
          INSERT INTO routing_providers (id, label, credit_multiplier)
          VALUES (${provider.id}, ${label}, ${managed})
          ON CONFLICT (id) DO UPDATE SET
            label = EXCLUDED.label,
            credit_multiplier = EXCLUDED.credit_multiplier,
            updated_at = now()
          RETURNING *`
      )[0];
      await writeAudit(ctx.user.id, 'routing_provider.update', 'routing_provider:' + provider.id, before, after, tx);

      if (!reprice || !provider.sourceIds.length) return;
      const previous = await tx`SELECT * FROM sources WHERE id = ANY(${provider.sourceIds})`;
      const updated = await tx`
        UPDATE sources SET credit_multiplier = ${data.creditMultiplier}, updated_at = now()
        WHERE id = ANY(${provider.sourceIds}) AND credit_multiplier <> ${data.creditMultiplier}
        RETURNING *`;
      for (const source of updated) {
        const old = previous.find((row) => row.id === source.id);
        await writeAudit(ctx.user.id, 'source.update', 'source:' + source.id, old, source, tx);
      }
      repriced = updated.length;
    });
    invalidate();
    return {
      status: 'success',
      message: repriced
        ? `Saved. Repriced ${repriced} ${repriced === 1 ? 'source' : 'sources'}.`
        : 'Saved.',
    };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof ApiError ? err.message : 'Could not save provider',
    };
  }
}

/** Stops holding a provider's sources to one multiplier; current prices stay. */
export async function releaseProviderPricingAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const id = z.string().min(1).max(255).parse(formData.get('id'));
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(20260921)`;
      const before = (await tx`SELECT * FROM routing_providers WHERE id = ${id} FOR UPDATE`)[0];
      if (!before) throw new ApiError('not_found', 'provider not found', 404);
      const after = (
        await tx`UPDATE routing_providers SET credit_multiplier = NULL, updated_at = now()
          WHERE id = ${id} RETURNING *`
      )[0];
      await writeAudit(ctx.user.id, 'routing_provider.update', 'routing_provider:' + id, before, after, tx);
    });
    invalidate();
    return { status: 'success', message: 'Sources can now be priced individually.' };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof ApiError ? err.message : 'Could not update provider',
    };
  }
}

/**
 * Picks the provider Auto routing starts with, ahead of each source's own
 * Default flag. An empty id clears it, leaving the per-source defaults.
 */
export async function setDefaultProviderAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const id = z.string().max(255).parse(formData.get('id') ?? '');
    let name = '';
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(20260921)`;
      if (id) {
        const provider = (await listProviderPricing(tx, id))[0];
        if (!provider) throw new ApiError('not_found', 'provider not found', 404);
        name = provider.label ?? provider.defaultLabel;
      }
      const cleared = await tx`SELECT * FROM routing_providers WHERE is_default AND id <> ${id} FOR UPDATE`;
      for (const before of cleared) {
        const after = (
          await tx`UPDATE routing_providers SET is_default = false, updated_at = now()
            WHERE id = ${before.id} RETURNING *`
        )[0];
        await writeAudit(ctx.user.id, 'routing_provider.update', 'routing_provider:' + before.id, before, after, tx);
      }
      if (!id) return;
      const before = (await tx`SELECT * FROM routing_providers WHERE id = ${id} FOR UPDATE`)[0] ?? null;
      if (before?.is_default) return;
      const after = (
        await tx`
          INSERT INTO routing_providers (id, is_default) VALUES (${id}, true)
          ON CONFLICT (id) DO UPDATE SET is_default = true, updated_at = now()
          RETURNING *`
      )[0];
      await writeAudit(ctx.user.id, 'routing_provider.update', 'routing_provider:' + id, before, after, tx);
    });
    invalidate();
    return {
      status: 'success',
      message: id ? `Auto now starts with ${name}.` : 'Auto now follows each source’s Default flag.',
    };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof ApiError ? err.message : 'Could not set the default provider',
    };
  }
}
