'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { requireAdmin, writeAudit } from '@/lib/api/admin';
import { ApiError } from '@/lib/api/errors';
import { MODELS } from '@/lib/ai/models';
import { encryptSecret } from '@/lib/crypto/aes';
import { sql } from '@/lib/db';
import { PROVIDERS } from '@/lib/admin/credentials';
import { probeCredentials } from '@/lib/admin/probe';

import type { ActionState } from '../_components/action-state';

const addSchema = z
  .object({
    provider: z.enum(PROVIDERS),
    baseUrl: z
      .string()
      .trim()
      .transform((v) => (v.length === 0 ? null : v)),
    apiKey: z.string().trim().min(1, 'api key is required'),
    modelId: z
      .string()
      .trim()
      .transform((v) => (v.length === 0 ? null : v)),
  })
  .refine((v) => v.provider !== 'openai_compatible' || v.baseUrl !== null, {
    message: 'openai_compatible requires a base URL',
    path: ['baseUrl'],
  });

/** Model to hit for the validation probe: caller override, else the cheap default. */
function probeModel(provider: string, modelId: string | null): string | null {
  if (modelId !== null) return modelId;
  return provider === 'anthropic' ? MODELS.cheap : null;
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

export async function addCredentialAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = addSchema.safeParse({
      provider: readString(formData, 'provider'),
      baseUrl: readString(formData, 'baseUrl'),
      apiKey: readString(formData, 'apiKey'),
      modelId: readString(formData, 'modelId'),
    });
    if (!parsed.success) {
      return { status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid input' };
    }
    const { provider, baseUrl, apiKey, modelId } = parsed.data;

    const model = probeModel(provider, modelId);
    if (model === null) {
      return { status: 'error', message: 'a model id is required to validate this credential' };
    }

    const probe = await probeCredentials({ provider, apiKey, baseUrl }, model);
    if (!probe.ok) {
      return { status: 'error', message: `validation failed: ${probe.error ?? 'unknown error'}` };
    }

    const { ciphertext, iv, authTag } = encryptSecret(apiKey);
    const lastFour = apiKey.slice(-4);

    await sql.begin(async (tx) => {
      const rows = await tx`
        INSERT INTO provider_credentials
          (owner_id, provider, base_url, ciphertext, iv, auth_tag, last_four, status)
        VALUES (NULL, ${provider}, ${baseUrl}, ${ciphertext}, ${iv}, ${authTag}, ${lastFour}, 'active')
        RETURNING id, provider, base_url, last_four, status
      `;
      await writeAudit(ctx.user.id, 'credential.add', `provider:${provider}`, null, rows[0], tx);
    });

    revalidatePath('/admin/credentials');
    return { status: 'success', message: `${provider} credential added (…${lastFour})` };
  } catch (err) {
    return { status: 'error', message: err instanceof ApiError ? err.message : 'add failed' };
  }
}

const rotateSchema = z
  .object({
    oldId: z.string().uuid('invalid credential id'),
    provider: z.enum(PROVIDERS),
    baseUrl: z
      .string()
      .trim()
      .transform((v) => (v.length === 0 ? null : v)),
    apiKey: z.string().trim().min(1, 'new api key is required'),
    modelId: z
      .string()
      .trim()
      .transform((v) => (v.length === 0 ? null : v)),
  })
  .refine((v) => v.provider !== 'openai_compatible' || v.baseUrl !== null, {
    message: 'openai_compatible requires a base URL',
    path: ['baseUrl'],
  });

export async function rotateCredentialAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = rotateSchema.safeParse({
      oldId: readString(formData, 'oldId'),
      provider: readString(formData, 'provider'),
      baseUrl: readString(formData, 'baseUrl'),
      apiKey: readString(formData, 'apiKey'),
      modelId: readString(formData, 'modelId'),
    });
    if (!parsed.success) {
      return { status: 'error', message: parsed.error.issues[0]?.message ?? 'invalid input' };
    }
    const { oldId, provider, baseUrl, apiKey, modelId } = parsed.data;

    const model = probeModel(provider, modelId);
    if (model === null) {
      return { status: 'error', message: 'a model id is required to validate this credential' };
    }

    const probe = await probeCredentials({ provider, apiKey, baseUrl }, model);
    if (!probe.ok) {
      return { status: 'error', message: `validation failed: ${probe.error ?? 'unknown error'}` };
    }

    const { ciphertext, iv, authTag } = encryptSecret(apiKey);
    const lastFour = apiKey.slice(-4);

    await sql.begin(async (tx) => {
      const oldRows = await tx`
        SELECT id, provider, base_url, last_four, status
        FROM provider_credentials WHERE id = ${oldId} AND owner_id IS NULL FOR UPDATE
      `;
      const oldRow = oldRows[0];
      if (oldRow === undefined) {
        throw new ApiError('not_found', 'credential not found', 404);
      }

      const newRows = await tx`
        INSERT INTO provider_credentials
          (owner_id, provider, base_url, ciphertext, iv, auth_tag, last_four, status)
        VALUES (NULL, ${provider}, ${baseUrl}, ${ciphertext}, ${iv}, ${authTag}, ${lastFour}, 'active')
        RETURNING id, provider, base_url, last_four, status
      `;
      await tx`UPDATE provider_credentials SET status = 'revoked' WHERE id = ${oldId}`;

      await writeAudit(
        ctx.user.id,
        'credential.rotate',
        `provider:${provider}`,
        oldRow,
        { revoked: oldRow, added: newRows[0] },
        tx,
      );
    });

    revalidatePath('/admin/credentials');
    return { status: 'success', message: `rotated ${provider} credential (new …${lastFour})` };
  } catch (err) {
    return { status: 'error', message: err instanceof ApiError ? err.message : 'rotate failed' };
  }
}

export async function revokeCredentialAction(formData: FormData): Promise<void> {
  const ctx = await requireAdmin();
  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) {
    throw new ApiError('invalid_request', 'missing credential id', 400);
  }

  await sql.begin(async (tx) => {
    const rows = await tx`
      SELECT id, provider, base_url, last_four, status
      FROM provider_credentials WHERE id = ${id} AND owner_id IS NULL FOR UPDATE
    `;
    const before = rows[0];
    if (before === undefined) {
      throw new ApiError('not_found', 'credential not found', 404);
    }
    const afterRows = await tx`
      UPDATE provider_credentials SET status = 'revoked' WHERE id = ${id}
      RETURNING id, provider, base_url, last_four, status
    `;
    await writeAudit(ctx.user.id, 'credential.revoke', `provider:${before.provider}`, before, afterRows[0], tx);
  });

  revalidatePath('/admin/credentials');
}
