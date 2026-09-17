'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getPlans } from '@/lib/billing/plans';
import { getEntitlement } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';
import { generateApiKey } from '@/lib/keys/api-key';
import { logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * API key mutations. Reads are RLS-scoped in the pages; every write here goes
 * through the service client, so each action re-establishes the session and
 * scopes the write to that user's id itself.
 */

export type CreateKeyState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  /** `key` is the only moment the plaintext is available — it is never stored. */
  | { status: 'created'; name: string; key: string };

export type RevokeKeyState = { status: 'idle' } | { status: 'error'; message: string };

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(64, 'Name must be 64 characters or less.'),
});

const revokeSchema = z.object({
  id: z.uuid('Invalid key id.'),
});

const insertedIdSchema = z.object({ id: z.string() });

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid input.';
}

export async function createApiKey(
  _previous: CreateKeyState,
  formData: FormData,
): Promise<CreateKeyState> {
  const user = await requireUser();
  const log = logger({ request_id: `dashboard:keys:create:${user.id}` });

  const parsed = createSchema.safeParse({ name: formData.get('name') });
  if (!parsed.success) {
    return { status: 'error', message: firstIssue(parsed.error) };
  }

  const entitlement = await getEntitlement(user.id);
  const rateLimitRpm = getPlans()[entitlement.planKey].rateLimitRpm;

  const generated = generateApiKey();
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      owner_id: user.id,
      name: parsed.data.name,
      key_hash: generated.hash,
      key_prefix: generated.prefix,
      last_four: generated.lastFour,
      rate_limit_rpm: rateLimitRpm,
    })
    .select('id')
    .single();

  if (error) {
    log.error('api key insert failed', { error: error.message });
    return { status: 'error', message: 'Could not create the key. Try again.' };
  }

  // Only non-secret identifiers are logged; the plaintext key never is.
  const inserted = insertedIdSchema.safeParse(data);
  log.info('api key created', {
    key_id: inserted.success ? inserted.data.id : null,
    key_prefix: generated.prefix,
    last_four: generated.lastFour,
    rate_limit_rpm: rateLimitRpm,
  });

  revalidatePath('/dashboard/keys');
  return { status: 'created', name: parsed.data.name, key: generated.key };
}

export async function revokeApiKey(
  _previous: RevokeKeyState,
  formData: FormData,
): Promise<RevokeKeyState> {
  const user = await requireUser();
  const log = logger({ request_id: `dashboard:keys:revoke:${user.id}` });

  const parsed = revokeSchema.safeParse({ id: formData.get('id') });
  if (!parsed.success) {
    return { status: 'error', message: firstIssue(parsed.error) };
  }

  const supabase = createServiceClient();
  // The owner_id filter IS the authorization check: a service-role update would
  // otherwise happily revoke somebody else's key.
  const { data, error } = await supabase
    .from('api_keys')
    .update({ status: 'revoked', revoked_at: new Date().toISOString() })
    .eq('id', parsed.data.id)
    .eq('owner_id', user.id)
    .eq('status', 'active')
    .select('id');

  if (error) {
    log.error('api key revoke failed', { error: error.message });
    return { status: 'error', message: 'Could not revoke the key. Try again.' };
  }

  const affected = z.array(insertedIdSchema).safeParse(data);
  if (!affected.success || affected.data.length === 0) {
    return { status: 'error', message: 'That key does not exist or is already revoked.' };
  }

  log.info('api key revoked', { key_id: parsed.data.id });
  revalidatePath('/dashboard/keys');
  return { status: 'idle' };
}
