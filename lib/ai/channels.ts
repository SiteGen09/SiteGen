import { z } from 'zod';
import { PROVIDERS, type Provider } from '@/lib/ai/providers';

import { sourceSchema, SOURCE_COLUMNS, type RoutingPreferences } from '@/lib/ai/sources';
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
const channelRowSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    task: z.string(),
    provider: z.enum(PROVIDERS),
    base_url: z.string().nullable(),
    model_id: z.string(),
    is_byok: z.boolean(),
    pricing_type: z.enum(['token', 'request']),
    source_id: z.string().nullable(),
    sources: sourceSchema.nullable(),
    status: z.string(),
    min_plan: z.string(),
    fallback_to: z.string().nullable(),
    priority: z.number().int(),
    input_per_mtok: z.coerce.number().nonnegative(),
    output_per_mtok: z.coerce.number().nonnegative(),
    cached_per_mtok: z.coerce.number().nonnegative(),
    public_model_id: z.string().nullable(),
  })
  .transform((row) => ({
    ...row,
    // Normalize once at the database boundary. Ranking and the fallback walker
    // must agree: an active channel on a degraded source is degraded end to end.
    effectiveStatus:
      row.status === 'off' || row.sources?.status === 'off'
        ? 'off'
        : row.status === 'degraded' || row.sources?.status === 'degraded'
          ? 'degraded'
          : row.status,
  }));

type ChannelDbRow = z.infer<typeof channelRowSchema>;

const CHANNEL_COLUMNS =
  'id, label, task, provider, base_url, model_id, is_byok, pricing_type, source_id, status, min_plan, fallback_to, priority, input_per_mtok, output_per_mtok, cached_per_mtok, public_model_id';
// An inner join excludes malformed platform rows without embedded filters. BYOK
// and fallback lookup use a left join because BYOK intentionally has no source.
const PLATFORM_COLUMNS = `${CHANNEL_COLUMNS}, sources!inner(${SOURCE_COLUMNS})`;
const ALL_COLUMNS = `${CHANNEL_COLUMNS}, sources(${SOURCE_COLUMNS})`;
const STATUS_RANK: Record<string, number> = { active: 2, degraded: 1 };

function toChannelRow(row: ChannelDbRow): ChannelRow {
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.base_url,
    modelId: row.model_id,
    creditMultiplier: row.is_byok ? '0' : sourceSchema.parse(row.sources).credit_multiplier,
    isByok: row.is_byok,
    status: row.effectiveStatus,
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
    const statusDelta =
      (STATUS_RANK[b.effectiveStatus] ?? 0) - (STATUS_RANK[a.effectiveStatus] ?? 0);
    if (statusDelta !== 0) return statusDelta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ranked.length > 0 ? toChannelRow(ranked[0]!) : null;
}

/** Source minimums cannot be bypassed by a less restricted channel on it. */
function eligibleForPlan(row: ChannelDbRow, planKey: string): boolean {
  // All current dispatchers bill tokens. Request-priced catalog entries must
  // wait for an endpoint that understands their unit instead of undercharging.
  return (
    row.pricing_type === 'token' &&
    row.status !== 'off' &&
    planMeetsMinimum(planKey, row.min_plan) &&
    (row.is_byok ||
      (row.sources !== null &&
        row.sources.status !== 'off' &&
        planMeetsMinimum(planKey, row.sources.min_plan)))
  );
}

/** A preference is a best effort: missing model coverage must not become a 404. */
function preferredOf(rows: ChannelDbRow[], preferences: RoutingPreferences): ChannelRow | null {
  return (
    bestOf(
      rows.filter(
        (row) => row.sources !== null && preferences.get(row.sources.family) === row.source_id,
      ),
    ) ??
    bestOf(rows.filter((row) => row.sources?.is_default === true)) ??
    bestOf(rows)
  );
}

/**
 * Picks the platform channel for `task` that `planKey` may use.
 *
 * Considers only channels that are on (`status != 'off'`), meet the plan's
 * minimum, and are platform routes (`is_byok = false`). BYOK
 * channels are BYOK-only and would bill the platform's own key for free, so
 * they are excluded here and reached through {@link selectByokChannel}.
 */
export async function selectChannel(task: TaskAlias, planKey: string): Promise<ChannelRow | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select(PLATFORM_COLUMNS)
    .eq('task', task)
    .neq('status', 'off')
    .eq('is_byok', false);

  if (error !== null) {
    throw new Error(`channel lookup failed: ${error.message}`);
  }

  const eligible = channelRowSchema
    .array()
    .parse(data ?? [])
    .filter((row) => eligibleForPlan(row, planKey));

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
    .select(ALL_COLUMNS)
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
    .filter((row) => eligibleForPlan(row, planKey));

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
  preferences: RoutingPreferences = new Map(),
): Promise<ChannelRow | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select(PLATFORM_COLUMNS)
    .eq('public_model_id', publicModelId)
    .neq('status', 'off')
    .eq('is_byok', false);

  if (error !== null) {
    throw new Error(`channel model lookup failed: ${error.message}`);
  }

  const eligible = channelRowSchema
    .array()
    .parse(data ?? [])
    .filter((row) => eligibleForPlan(row, planKey));

  return preferredOf(eligible, preferences);
}

/**
 * Every model name `planKey` may reach, newest-first by id for a stable list.
 * Returns only `public_model_id` values: the upstream `model_id`, base URL,
 * and multiplier must never reach a caller.
 */
export async function listPublicModels(
  planKey: string,
  preferences: RoutingPreferences = new Map(),
): Promise<string[]> {
  const { data, error } = await createServiceClient()
    .from('channels')
    .select(PLATFORM_COLUMNS)
    .not('public_model_id', 'is', null)
    .neq('status', 'off')
    .eq('is_byok', false);
  if (error) throw new Error(`public model lookup failed: ${error.message}`);
  const rows = channelRowSchema
    .array()
    .parse(data ?? [])
    .filter((row) => eligibleForPlan(row, planKey));
  // Several sources can serve the same public name; enumerate names once using
  // precisely the same eligibility and cascade as the dispatch path.
  return [
    ...new Set(rows.flatMap((row) => (row.public_model_id === null ? [] : [row.public_model_id]))),
  ]
    .filter(
      (id) =>
        preferredOf(
          rows.filter((row) => row.public_model_id === id),
          preferences,
        ) !== null,
    )
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
    .select(ALL_COLUMNS)
    .eq('id', id)
    .neq('status', 'off')
    .maybeSingle();

  if (error !== null) {
    throw new Error(`channel resolve failed: ${error.message}`);
  }
  if (data === null) return null;

  const row = channelRowSchema.parse(data);
  if (row.pricing_type !== 'token') return null;
  if (!row.is_byok && (row.sources === null || row.sources.status === 'off')) return null;
  return toChannelRow(row);
}
