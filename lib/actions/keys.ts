'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { USD_PER_CREDIT } from '@/lib/ai/pricing';
import { publicRoutingSourceId } from '@/lib/ai/routing-provider';
import { getPlans } from '@/lib/billing/plans';
import { loadKeyRoutingChoices } from '@/lib/dashboard/key-routing-choices';
import { getEntitlement } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';
import { generateApiKey } from '@/lib/keys/api-key';
import { decryptApiKey, encryptApiKey, type StoredKeyColumns } from '@/lib/keys/stored-key';
import { MAX_ALLOWED_IPS, parseIpList } from '@/lib/keys/key-policy';
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
  /** Only the hash authenticates; an encrypted copy lets the owner copy it again. */
  | { status: 'created'; name: string; key: string };

export type RevealKeyResult = { status: 'ok'; key: string } | { status: 'error'; message: string };

export type UpdateKeyState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'saved'; at: number };

export type RevokeKeyState = { status: 'idle' } | { status: 'error'; message: string };

/** Largest spending limit a key can carry, in USD. */
const MAX_QUOTA_USD = 1_000_000;
const MAX_MODELS = 500;
const ROUTE_FIELD = 'route:';

const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required.')
  .max(64, 'Name must be 64 characters or less.');

const idSchema = z.uuid('Invalid key id.');

const insertedIdSchema = z.object({ id: z.string() });

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Invalid input.';
}

/** The editable columns, as written to `api_keys`. */
interface KeySettings {
  name: string;
  expires_at: string | null;
  quota_credits: number | null;
  allowed_models: string[] | null;
  allowed_ips: string[] | null;
  routing_provider_id: string | null;
  routing_sources: Record<string, string>;
}

/**
 * Validates the create/edit form into columns. Routing choices arrive as the
 * public ids the page shows and are mapped back to internal ids here, against
 * what the owner's plan can reach today.
 */
async function parseSettings(formData: FormData, userId: string): Promise<KeySettings | string> {
  const name = nameSchema.safeParse(formData.get('name'));
  if (!name.success) return firstIssue(name.error);

  const expiresText = String(formData.get('expiresAt') ?? '').trim();
  let expiresAt: string | null = null;
  if (expiresText !== '') {
    const parsed = Date.parse(expiresText);
    if (!Number.isFinite(parsed)) return 'Enter a valid expiration time.';
    if (parsed <= Date.now()) return 'The expiration time must be in the future.';
    expiresAt = new Date(parsed).toISOString();
  }

  let quotaCredits: number | null = null;
  if (formData.get('unlimited') !== 'on') {
    const usd = Number(String(formData.get('quotaUsd') ?? '').trim());
    if (String(formData.get('quotaUsd') ?? '').trim() === '' || !Number.isFinite(usd) || usd < 0) {
      return 'Enter a quota in USD, or turn on unlimited quota.';
    }
    if (usd > MAX_QUOTA_USD) return `The quota can be at most $${MAX_QUOTA_USD.toLocaleString('en-US')}.`;
    quotaCredits = Math.round(usd / USD_PER_CREDIT);
  }

  let allowedModels: string[] | null = null;
  if (formData.get('modelsMode') === 'selected') {
    const models = [...new Set(formData.getAll('models').map((value) => String(value).trim()).filter(Boolean))];
    if (models.length === 0) return 'Choose at least one model, or allow all models.';
    if (models.length > MAX_MODELS) return `Choose at most ${MAX_MODELS} models.`;
    if (models.some((model) => model.length > 200)) return 'A model name is too long.';
    allowedModels = models.sort();
  }

  const ips = parseIpList(String(formData.get('ips') ?? ''));
  if (ips.invalid.length > 0) return `Not an IP address or CIDR range: ${ips.invalid.slice(0, 3).join(', ')}`;
  if (ips.entries.length > MAX_ALLOWED_IPS) return `Enter at most ${MAX_ALLOWED_IPS} IP addresses or ranges.`;

  const providerChoice = String(formData.get('routingProvider') ?? '');
  const routeChoices = [...formData.entries()].flatMap(([field, value]) =>
    field.startsWith(ROUTE_FIELD) && String(value) !== '' ? [[field.slice(ROUTE_FIELD.length), String(value)] as const] : []);

  let routingProviderId: string | null = null;
  const routingSources: Record<string, string> = {};
  if (providerChoice !== '' || routeChoices.length > 0) {
    const entitlement = await getEntitlement(userId);
    const choices = await loadKeyRoutingChoices(entitlement.planKey);
    if (providerChoice !== '') {
      const provider = choices.providers.find((item) => item.publicId === providerChoice);
      if (!provider) return 'The chosen provider is unavailable on your plan.';
      routingProviderId = provider.id;
    }
    for (const [key, publicId] of routeChoices) {
      const [family, modality] = key.split(':');
      const source = choices.eligibleSources.find((item) =>
        item.family === family && item.modality === modality && publicRoutingSourceId(item.id) === publicId);
      if (!source) return 'A chosen source is unavailable on your plan.';
      routingSources[key] = source.id;
    }
  }

  return {
    name: name.data,
    expires_at: expiresAt,
    quota_credits: quotaCredits,
    allowed_models: allowedModels,
    allowed_ips: ips.entries.length > 0 ? ips.entries : null,
    routing_provider_id: routingProviderId,
    routing_sources: routingSources,
  };
}

export async function createApiKey(
  _previous: CreateKeyState,
  formData: FormData,
): Promise<CreateKeyState> {
  const user = await requireUser();
  const log = logger({ request_id: `dashboard:keys:create:${user.id}` });

  const settings = await parseSettings(formData, user.id);
  if (typeof settings === 'string') return { status: 'error', message: settings };

  const entitlement = await getEntitlement(user.id);
  const rateLimitRpm = getPlans()[entitlement.planKey].rateLimitRpm;

  const generated = generateApiKey();
  // A key without a stored copy still works; it just cannot be copied later.
  let copy: StoredKeyColumns | null = null;
  try {
    copy = encryptApiKey(generated.key);
  } catch (error) {
    log.error('api key copy encryption failed', { error: error instanceof Error ? error.message : String(error) });
  }
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      owner_id: user.id,
      ...settings,
      key_hash: generated.hash,
      key_prefix: generated.prefix,
      last_four: generated.lastFour,
      rate_limit_rpm: rateLimitRpm,
      ...copy,
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
  return { status: 'created', name: settings.name, key: generated.key };
}

export async function updateApiKey(
  _previous: UpdateKeyState,
  formData: FormData,
): Promise<UpdateKeyState> {
  const user = await requireUser();
  const log = logger({ request_id: `dashboard:keys:update:${user.id}` });

  const id = idSchema.safeParse(formData.get('id'));
  if (!id.success) return { status: 'error', message: firstIssue(id.error) };
  const settings = await parseSettings(formData, user.id);
  if (typeof settings === 'string') return { status: 'error', message: settings };

  // The owner_id filter IS the authorization check, and a revoked key stays
  // revoked: it cannot be edited back into use.
  const { data, error } = await createServiceClient()
    .from('api_keys')
    .update(settings)
    .eq('id', id.data)
    .eq('owner_id', user.id)
    .neq('status', 'revoked')
    .select('id');

  if (error) {
    log.error('api key update failed', { error: error.message });
    return { status: 'error', message: 'Could not save the key. Try again.' };
  }
  const affected = z.array(insertedIdSchema).safeParse(data);
  if (!affected.success || affected.data.length === 0) {
    return { status: 'error', message: 'That key does not exist or has been revoked.' };
  }

  log.info('api key updated', { key_id: id.data });
  revalidatePath('/dashboard/keys');
  return { status: 'saved', at: Date.now() };
}

/** Pauses or resumes a key. Unlike revoking, a disabled key can be turned back on. */
export async function setApiKeyEnabled(
  _previous: RevokeKeyState,
  formData: FormData,
): Promise<RevokeKeyState> {
  const user = await requireUser();
  const log = logger({ request_id: `dashboard:keys:toggle:${user.id}` });

  const parsed = z
    .object({ id: idSchema, enabled: z.enum(['true', 'false']) })
    .safeParse({ id: formData.get('id'), enabled: formData.get('enabled') });
  if (!parsed.success) return { status: 'error', message: firstIssue(parsed.error) };

  const enable = parsed.data.enabled === 'true';
  const { data, error } = await createServiceClient()
    .from('api_keys')
    .update({ status: enable ? 'active' : 'disabled' })
    .eq('id', parsed.data.id)
    .eq('owner_id', user.id)
    .eq('status', enable ? 'disabled' : 'active')
    .select('id');

  if (error) {
    log.error('api key toggle failed', { error: error.message });
    return { status: 'error', message: 'Could not change the key. Try again.' };
  }
  const affected = z.array(insertedIdSchema).safeParse(data);
  if (!affected.success || affected.data.length === 0) {
    return { status: 'error', message: 'That key does not exist or has changed. Refresh and try again.' };
  }

  log.info(enable ? 'api key enabled' : 'api key disabled', { key_id: parsed.data.id });
  revalidatePath('/dashboard/keys');
  return { status: 'idle' };
}

export async function revokeApiKey(
  _previous: RevokeKeyState,
  formData: FormData,
): Promise<RevokeKeyState> {
  const user = await requireUser();
  const log = logger({ request_id: `dashboard:keys:revoke:${user.id}` });

  const parsed = z.object({ id: idSchema }).safeParse({ id: formData.get('id') });
  if (!parsed.success) {
    return { status: 'error', message: firstIssue(parsed.error) };
  }

  const supabase = createServiceClient();
  // The owner_id filter IS the authorization check: a service-role update would
  // otherwise happily revoke somebody else's key.
  const { data, error } = await supabase
    .from('api_keys')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      key_ciphertext: null,
      key_iv: null,
      key_auth_tag: null,
    })
    .eq('id', parsed.data.id)
    .eq('owner_id', user.id)
    .neq('status', 'revoked')
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

/** Returns the full key so its owner can copy it. Revoked keys keep no copy. */
export async function revealApiKey(id: string): Promise<RevealKeyResult> {
  const user = await requireUser();
  const log = logger({ request_id: `dashboard:keys:reveal:${user.id}` });

  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { status: 'error', message: firstIssue(parsed.error) };

  const { data, error } = await createServiceClient()
    .from('api_keys')
    .select('status, key_ciphertext, key_iv, key_auth_tag')
    .eq('id', parsed.data)
    .eq('owner_id', user.id)
    .maybeSingle();

  if (error) {
    log.error('api key reveal failed', { error: error.message });
    return { status: 'error', message: 'Could not load the key. Try again.' };
  }
  if (!data || data.status === 'revoked') return { status: 'error', message: 'That key does not exist or is revoked.' };

  let key: string | null;
  try {
    key = decryptApiKey(data);
  } catch (error) {
    log.error('api key decrypt failed', { key_id: parsed.data, error: error instanceof Error ? error.message : String(error) });
    return { status: 'error', message: 'Could not load the key. Try again.' };
  }
  if (key === null) {
    return { status: 'error', message: 'This key was created before keys could be copied. Create a new key to get one you can copy.' };
  }

  log.info('api key copied', { key_id: parsed.data });
  return { status: 'ok', key };
}

/**
 * Replaces a key's secret and keeps its name and settings. The old secret
 * stops working at once. Lets keys made before copies were stored become
 * copyable without being set up again.
 */
export async function regenerateApiKey(id: string): Promise<RevealKeyResult> {
  const user = await requireUser();
  const log = logger({ request_id: `dashboard:keys:regenerate:${user.id}` });

  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return { status: 'error', message: firstIssue(parsed.error) };

  const generated = generateApiKey();
  let copy: StoredKeyColumns;
  try {
    copy = encryptApiKey(generated.key);
  } catch (error) {
    log.error('api key copy encryption failed', { error: error instanceof Error ? error.message : String(error) });
    return { status: 'error', message: 'Could not regenerate the key. Try again.' };
  }

  // The owner_id filter IS the authorization check; revoked keys stay revoked.
  const { data, error } = await createServiceClient()
    .from('api_keys')
    .update({ key_hash: generated.hash, key_prefix: generated.prefix, last_four: generated.lastFour, ...copy })
    .eq('id', parsed.data)
    .eq('owner_id', user.id)
    .neq('status', 'revoked')
    .select('id');

  if (error) {
    log.error('api key regenerate failed', { error: error.message });
    return { status: 'error', message: 'Could not regenerate the key. Try again.' };
  }
  const affected = z.array(insertedIdSchema).safeParse(data);
  if (!affected.success || affected.data.length === 0) {
    return { status: 'error', message: 'That key does not exist or is revoked.' };
  }

  log.info('api key regenerated', { key_id: parsed.data, key_prefix: generated.prefix, last_four: generated.lastFour });
  revalidatePath('/dashboard/keys');
  return { status: 'ok', key: generated.key };
}
