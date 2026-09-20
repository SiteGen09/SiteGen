import { z } from 'zod';
import { PROVIDERS, type Provider } from '@/lib/ai/providers';

import type { ChannelRow } from '@/lib/ai/fallback';
import type { TaskAlias } from '@/lib/ai/provider';
import { planMeetsMinimum } from '@/lib/billing/plans';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Raw channel row as PostgREST returns it. `credit_multiplier` is a
 * `numeric(10,2)`, which supabase-js surfaces as a JSON string, so it is
 * carried as a string all the way to {@link ChannelRow.creditMultiplier}
 * rather than being parsed through a lossy float.
 */
const channelRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  task: z.string(),
  provider: z.enum(PROVIDERS),
  base_url: z.string().nullable(),
  model_id: z.string(),
  is_byok: z.boolean(),
  credit_multiplier: z.union([z.string(), z.number()]).transform(String),
  status: z.string(),
  min_plan: z.string(),
  fallback_to: z.string().nullable(),
  priority: z.number().int(),
  input_per_mtok: z.coerce.number().nonnegative(),
  output_per_mtok: z.coerce.number().nonnegative(),
  cached_per_mtok: z.coerce.number().nonnegative(),
  public_model_id: z.string().nullable(),
});

type ChannelDbRow = z.infer<typeof channelRowSchema>;

const CHANNEL_COLUMNS =
  'id, label, task, provider, base_url, model_id, is_byok, credit_multiplier, status, min_plan, fallback_to, priority, input_per_mtok, output_per_mtok, cached_per_mtok, public_model_id';
const STATUS_RANK: Record<string, number> = { active: 2, degraded: 1 };

function toChannelRow(row: ChannelDbRow): ChannelRow {
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.base_url,
    modelId: row.model_id,
    creditMultiplier: row.credit_multiplier,
    isByok: row.is_byok,
    status: row.status,
    fallbackTo: row.fallback_to,
    rates: {
      inputPerMTok: row.input_per_mtok,
      outputPerMTok: row.output_per_mtok,
      cachedPerMTok: row.cached_per_mtok,
    },
  };
}

/**
 * Orders usable channels best-first: highest priority, then `active` over
 * `degraded`. Ties beyond that are broken by id for a stable result.
 */
function bestOf(rows: ChannelDbRow[]): ChannelRow | null {
  const ranked = [...rows].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const statusDelta = (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0);
    if (statusDelta !== 0) return statusDelta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ranked.length > 0 ? toChannelRow(ranked[0]!) : null;
}

/**
 * Picks the platform channel for `task` that `planKey` may use.
 *
 * Considers only channels that are on (`status != 'off'`), meet the plan's
 * minimum, and are platform routes (`is_byok = false`). BYOK
 * channels are BYOK-only and would bill the platform's own key for free, so
 * they are excluded here and reached through {@link selectByokChannel}.
 */
export async function selectChannel(
  task: TaskAlias,
  planKey: string,
): Promise<ChannelRow | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('task', task)
    .neq('status', 'off')
    .eq('is_byok', false);

  if (error !== null) {
    throw new Error(`channel lookup failed: ${error.message}`);
  }

  const eligible = channelRowSchema
    .array()
    .parse(data ?? [])
    .filter((row) => planMeetsMinimum(planKey, row.min_plan));

  return bestOf(eligible);
}

/**
 * Picks the BYOK channel for `task` on `provider` that `planKey` may use.
 *
 * BYOK channels carry `credit_multiplier = 0`: the caller's own key pays the
 * provider, so no credits are held or charged. Provider must match the user's
 * stored credential so the decrypted key targets the right API.
 */
export async function selectByokChannel(
  task: TaskAlias,
  provider: Provider,
  planKey: string,
): Promise<ChannelRow | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('task', task)
    .eq('provider', provider)
    .neq('status', 'off')
    .eq('is_byok', true);

  if (error !== null) {
    throw new Error(`byok channel lookup failed: ${error.message}`);
  }

  const eligible = channelRowSchema
    .array()
    .parse(data ?? [])
    .filter((row) => planMeetsMinimum(planKey, row.min_plan));

  return bestOf(eligible);
}

/**
 * Picks the gateway channel a caller addressed by `publicModelId`.
 *
 * Deliberately mirrors {@link selectChannel}: `off` channels are excluded,
 * BYOK-only channels are not billable here, and the plan
 * minimum is enforced. An unknown name and a name the caller's plan cannot
 * reach both return `null`, so the caller cannot tell "no such model" from
 * "your plan cannot use this model".
 */
export async function selectChannelByModel(
  publicModelId: string,
  planKey: string,
): Promise<ChannelRow | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('public_model_id', publicModelId)
    .neq('status', 'off')
    .eq('is_byok', false);

  if (error !== null) {
    throw new Error(`channel model lookup failed: ${error.message}`);
  }

  const eligible = channelRowSchema
    .array()
    .parse(data ?? [])
    .filter((row) => planMeetsMinimum(planKey, row.min_plan));

  return bestOf(eligible);
}

/**
 * Every model name `planKey` may reach, newest-first by id for a stable list.
 * Returns only `public_model_id` values: the upstream `model_id`, base URL,
 * and multiplier must never reach a caller.
 */
export async function listPublicModels(planKey: string): Promise<string[]> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .not('public_model_id', 'is', null)
    .neq('status', 'off')
    .eq('is_byok', false);

  if (error !== null) {
    throw new Error(`public model lookup failed: ${error.message}`);
  }

  return channelRowSchema
    .array()
    .parse(data ?? [])
    .filter((row) => planMeetsMinimum(planKey, row.min_plan))
    .map((row) => row.public_model_id)
    .filter((id): id is string => id !== null)
    .sort();
}

/**
 * Resolves a channel by id for the fallback walker. Returns `null` for a
 * missing or fully off channel so the walk stops rather than attempting it.
 */
export async function resolveChannel(id: string): Promise<ChannelRow | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('id', id)
    .neq('status', 'off')
    .maybeSingle();

  if (error !== null) {
    throw new Error(`channel resolve failed: ${error.message}`);
  }
  if (data === null) return null;

  return toChannelRow(channelRowSchema.parse(data));
}
