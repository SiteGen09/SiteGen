'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { MODELS } from '@/lib/ai/models';
import { PROVIDERS, requiresBaseUrl, type Provider } from '@/lib/ai/providers';
import { encryptSecret } from '@/lib/crypto/aes';
import { requireUser } from '@/lib/dashboard/session';
import { logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * BYOK provider credential mutations.
 *
 * Every key is proved against the live provider before it is stored, so a typo
 * fails here instead of at generation time. The plaintext exists only inside
 * these functions: it is never logged, never returned, and never re-read after
 * encryption.
 */

export type CredentialState = { status: 'idle' | 'saved' } | { status: 'error'; message: string };

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';
const VALIDATION_TIMEOUT_MS = 15_000;

const addSchema = z
  .object({
    provider: z.enum(PROVIDERS),
    apiKey: z.string().trim().min(8, 'That API key looks too short.'),
    baseUrl: z
      .string()
      .trim()
      .transform((value) => (value === '' ? null : value))
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (requiresBaseUrl(value.provider) && value.baseUrl === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'Base URL is required for a compatible provider.',
      });
      return;
    }
    if (value.baseUrl !== null && !/^https:\/\/\S+$/.test(value.baseUrl)) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'Base URL must be an https:// URL.',
      });
    }
  });

const revokeSchema = z.object({ id: z.uuid('Invalid credential id.') });
const insertedIdSchema = z.object({ id: z.string() });

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid input.';
}

/** Postgres `bytea` over supabase-js: hex-escape format. */
function toByteaHex(buffer: Buffer): string {
  return `\\x${buffer.toString('hex')}`;
}

type ValidationResult = { ok: true } | { ok: false; message: string };

function trimBase(baseUrl: string | null): string {
  return (baseUrl ?? '').replace(/\/+$/, '');
}

/**
 * One minimal live request per protocol, proving the key before it is stored.
 *
 * Each kind is probed the way its own protocol expects, never another's:
 *
 *  - `anthropic` — POST /messages at Anthropic's own host, with a known-good
 *    model, since the form collects no model id.
 *  - `anthropic_compatible` — GET /models at the user's gateway with Anthropic
 *    auth headers. A model id would be a guess here (a gateway names its own
 *    models), and probing /messages with a wrong one returns 404, which is
 *    indistinguishable from a bad key.
 *  - `openai_compatible` — GET /models with bearer auth.
 */
async function validateCredential(
  provider: Provider,
  apiKey: string,
  baseUrl: string | null,
): Promise<ValidationResult> {
  const signal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);

  let response: Response;
  try {
    if (provider === 'anthropic') {
      response = await fetch(`${ANTHROPIC_BASE_URL}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: MODELS.cheap,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal,
      });
    } else if (provider === 'anthropic_compatible') {
      response = await fetch(`${trimBase(baseUrl)}/models`, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        signal,
      });
    } else {
      response = await fetch(`${trimBase(baseUrl)}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
        signal,
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    return { ok: false, message: `Could not reach the provider: ${reason}` };
  }

  if (response.ok) return { ok: true };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, message: 'The provider rejected that key.' };
  }
  return {
    ok: false,
    message: `The provider returned HTTP ${response.status}; the key could not be verified.`,
  };
}

export async function addCredential(
  _previous: CredentialState,
  formData: FormData,
): Promise<CredentialState> {
  const user = await requireUser();
  const log = logger({ request_id: `dashboard:credentials:add:${user.id}` });

  const parsed = addSchema.safeParse({
    provider: formData.get('provider'),
    apiKey: formData.get('api_key'),
    baseUrl: formData.get('base_url') ?? '',
  });
  if (!parsed.success) {
    return { status: 'error', message: firstIssue(parsed.error) };
  }

  const { provider, apiKey, baseUrl } = parsed.data;

  const validation = await validateCredential(provider, apiKey, baseUrl);
  if (!validation.ok) {
    log.warn('credential validation failed', { provider, reason: validation.message });
    return { status: 'error', message: validation.message };
  }

  const { ciphertext, iv, authTag } = encryptSecret(apiKey);
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('provider_credentials')
    .insert({
      owner_id: user.id,
      provider,
      base_url: baseUrl,
      ciphertext: toByteaHex(ciphertext),
      iv: toByteaHex(iv),
      auth_tag: toByteaHex(authTag),
      last_four: apiKey.slice(-4),
    })
    .select('id')
    .single();

  if (error) {
    log.error('credential insert failed', { provider, error: error.message });
    return { status: 'error', message: 'Validated the key but could not save it. Try again.' };
  }

  const inserted = insertedIdSchema.safeParse(data);
  log.info('credential saved', {
    provider,
    credential_id: inserted.success ? inserted.data.id : null,
    last_four: apiKey.slice(-4),
  });

  revalidatePath('/dashboard/credentials');
  return { status: 'saved' };
}

export async function revokeCredential(
  _previous: CredentialState,
  formData: FormData,
): Promise<CredentialState> {
  const user = await requireUser();
  const log = logger({ request_id: `dashboard:credentials:revoke:${user.id}` });

  const parsed = revokeSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) {
    return { status: 'error', message: firstIssue(parsed.error) };
  }

  const supabase = createServiceClient();
  // owner_id in the filter is the authorization check for this service-role write.
  const { data, error } = await supabase
    .from('provider_credentials')
    .update({ status: 'revoked' })
    .eq('id', parsed.data.id)
    .eq('owner_id', user.id)
    .eq('status', 'active')
    .select('id');

  if (error) {
    log.error('credential revoke failed', { error: error.message });
    return { status: 'error', message: 'Could not revoke the credential. Try again.' };
  }

  const affected = z.array(insertedIdSchema).safeParse(data);
  if (!affected.success || affected.data.length === 0) {
    return { status: 'error', message: 'That credential does not exist or is already revoked.' };
  }

  log.info('credential revoked', { credential_id: parsed.data.id });
  revalidatePath('/dashboard/credentials');
  return { status: 'idle' };
}
