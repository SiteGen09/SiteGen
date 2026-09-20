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
import { providerEndpoint, type ProviderCreds } from '@/lib/ai/provider';
import { acceptsBaseUrl, PROVIDER_LABELS, requiresBaseUrl, type Provider } from '@/lib/ai/providers';

import type { ActionState } from '../_components/action-state';

/**
 * The upstream every credential form describes. `add`, `rotate` and `test`
 * share one shape deliberately: a credential that tests green has to be the
 * same credential that gets stored, or the test proves nothing.
 */
const credentialFields = {
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
};

/**
 * A compatible gateway is identified by its base URL, so it must carry one.
 * `anthropic` must not: `buildAI` builds the first-party client without a
 * `baseURL`, so a URL stored there is inert. Rejecting the inert case outright
 * is what stops a relay URL from being saved against the first party and
 * quietly doing nothing — the failure mode `anthropic_compatible` exists to
 * fix.
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

const addSchema = z.object({ ...credentialFields }).superRefine(checkBaseUrl);

/** Model to hit for the validation probe: caller override, else the cheap default. */
function probeModel(provider: string, modelId: string | null): string | null {
  if (modelId !== null) return modelId;
  return provider === 'anthropic' ? MODELS.cheap : null;
}

function readString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

/**
 * Probes a credential and phrases the result for an admin.
 *
 * Every message names the endpoint actually contacted. Provider `anthropic`
 * discards `baseUrl` (see `buildAI`), so without naming it a relay key
 * rejected by api.anthropic.com reads as "bad key" when the real fault is a
 * base URL typed against the wrong provider.
 */
async function describeProbe(creds: ProviderCreds, model: string) {
  const endpoint = providerEndpoint(creds);
  const probe = await probeCredentials(creds, model);
  const target = `${endpoint} · ${model}`;
  return {
    probe,
    endpoint,
    failure: `validation failed (${target}): ${probe.error ?? 'unknown error'}`,
    success: `${target} answered in ${probe.latencyMs} ms`,
  };
}

const testSchema = z.object({ ...credentialFields }).superRefine(checkBaseUrl);

/**
 * Live round trip against a credential without storing it.
 *
 * Same probe the add/rotate paths run, split out so an admin can find a
 * working provider/base-URL/model combination before committing a key — the
 * failing path costs nothing and leaves no revoked rows behind. The key is
 * never persisted here and never echoed back.
 */
export async function testCredentialAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const ctx = await requireAdmin();
    const parsed = testSchema.safeParse({
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
      return { status: 'error', message: 'a model id is required to test this credential' };
    }

    const { probe, endpoint, failure, success } = await describeProbe(
      { provider, apiKey, baseUrl },
      model,
    );

    // A test spends real tokens against a real upstream, so it is auditable in
    // the same way `channel.test` is. Only the last four characters of the key
    // would ever identify it, and even those are withheld until it is stored.
    await writeAudit(ctx.user.id, 'credential.test', `provider:${provider}`, null, {
      endpoint,
      model,
      ok: probe.ok,
      latency_ms: probe.latencyMs,
      error: probe.error ?? null,
    });

    return probe.ok
      ? { status: 'success', message: `connection ok — ${success} (not saved)` }
      : { status: 'error', message: failure };
  } catch (err) {
    return { status: 'error', message: err instanceof ApiError ? err.message : 'test failed' };
  }
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

    const { probe, failure } = await describeProbe({ provider, apiKey, baseUrl }, model);
    if (!probe.ok) {
      return { status: 'error', message: failure };
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
    ...credentialFields,
    apiKey: z.string().trim().min(1, 'new api key is required'),
  })
  .superRefine(checkBaseUrl);

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

    const { probe, failure } = await describeProbe({ provider, apiKey, baseUrl }, model);
    if (!probe.ok) {
      return { status: 'error', message: failure };
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
