import { z } from 'zod';
import { billingPolicySchema, policyRates, type BillingPolicy } from '@/lib/ai/billing-policy';
import { PROVIDERS, type Provider } from '@/lib/ai/providers';

import {
  routingKey,
  sourceSchema,
  SOURCE_COLUMNS,
  type Modality,
  type RoutingPreferences,
} from '@/lib/ai/sources';
import { MAX_CHAIN_DEPTH, type ChannelRow } from '@/lib/ai/fallback';
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
    billing_policy: billingPolicySchema.nullish(),
    public_model_id: z.string().nullable(),
    // Optional rather than required: only request-priced rows carry a value,
    // and a row that somehow arrives without the column must degrade to "not
    // an image channel" rather than failing every channel lookup. numeric
    // arrives from PostgREST as a string, hence the union.
    request_price_usd: z
      .union([z.string(), z.number()])
      .nullable()
      .optional()
      .transform((value) => (value === null || value === undefined ? null : Number(value))),
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
  'id, label, task, provider, base_url, model_id, is_byok, pricing_type, source_id, status, min_plan, fallback_to, priority, input_per_mtok, output_per_mtok, cached_per_mtok, public_model_id, request_price_usd, billing_policy';
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
    rates: row.billing_policy ? policyRates(row.billing_policy) : {
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
function rankRows(rows: ChannelDbRow[]): ChannelDbRow[] {
  return [...rows].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const statusDelta =
      (STATUS_RANK[b.effectiveStatus] ?? 0) - (STATUS_RANK[a.effectiveStatus] ?? 0);
    if (statusDelta !== 0) return statusDelta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function bestOf(rows: ChannelDbRow[]): ChannelRow | null {
  const ranked = rankRows(rows);
  return ranked.length > 0 ? toChannelRow(ranked[0]!) : null;
}

/**
 * Source minimums cannot be bypassed by a less restricted channel on it.
 *
 * `pricingType` is explicit rather than assumed because a dispatcher may only
 * route what it can bill: the chat pipeline charges per token, the image
 * endpoint per request, and offering either one the other's rows would
 * undercharge silently.
 */
function eligibleForPlan(
  row: ChannelDbRow,
  planKey: string,
  pricingType: 'token' | 'request' = 'token',
): boolean {
  return (
    row.pricing_type === pricingType &&
    row.status !== 'off' &&
    planMeetsMinimum(planKey, row.min_plan) &&
    (row.is_byok ||
      (row.sources !== null &&
        row.sources.status !== 'off' &&
        planMeetsMinimum(planKey, row.sources.min_plan)))
  );
}

/**
 * A preference is a best effort: missing model coverage must not become a 404.
 *
 * `modality` scopes the lookup because a preference is keyed on the pair. A
 * user's choice of chat gateway must not decide who renders their video, and
 * before the key was widened it did exactly that.
 */
function preferredOf(
  rows: ChannelDbRow[],
  preferences: RoutingPreferences,
  modality: Modality,
): ChannelRow | null {
  return (
    bestOf(
      rows.filter(
        (row) =>
          row.sources !== null &&
          preferences.get(routingKey(row.sources.family, modality)) === row.source_id,
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
  return preferredOf(await modelChannels(publicModelId, planKey), preferences, 'chat');
}

async function modelChannels(publicModelId: string, planKey: string): Promise<ChannelDbRow[]> {
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

  return channelRowSchema
    .array()
    .parse(data ?? [])
    .filter((row) => !row.is_byok && row.sources?.modality === 'chat' && eligibleForPlan(row, planKey));
}

/**
 * A request-scoped Auto chain for the same public model. Candidates have all
 * passed source, modality and plan checks. Explicit preferences retain the
 * configured fallback links and do not opt in to sibling-provider retries.
 */
export async function selectChatRoute(
  publicModelId: string,
  planKey: string,
  preferences: RoutingPreferences = new Map(),
): Promise<{ start: ChannelRow; holdChannels?: ChannelRow[]; resolve: (id: string) => Promise<ChannelRow | null> } | null> {
  const eligible = await modelChannels(publicModelId, planKey);
  const selected = preferredOf(eligible, preferences, 'chat');
  if (!selected) return null;
  const source = eligible.find((row) => row.id === selected.id)!.sources!;
  if (preferences.has(routingKey(source.family, 'chat'))) {
    return { start: selected, resolve: (id) => resolveChannel(id, planKey) };
  }
  const rest = rankRows(eligible.filter((row) => row.id !== selected.id && row.sources?.family === source.family))
    .sort((a, b) => Number(b.sources?.is_default) - Number(a.sources?.is_default));
  const ordered = [selected, ...rest.map(toChannelRow)];
  const channels = new Map(ordered.map((row) => [row.id, {
    ...row,
    automaticRouting: true,
  }]));
  const start = { ...channels.get(selected.id)!, automaticFallbackIds: rest.map((row) => row.id) };
  return {
    start,
    holdChannels: ordered.slice(0, MAX_CHAIN_DEPTH),
    resolve: async (id) => {
      const sibling = channels.get(id);
      if (sibling) return sibling;
      // Existing admin-configured chains may deliberately use a different
      // model. Preserve them after same-model providers, enforcing plan limits.
      const configured = await resolveChannel(id, planKey);
      return configured ? { ...configured, automaticRouting: true } : null;
    },
  };
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
          'chat',
        ) !== null,
    )
    .sort();
}

/**
 * Resolves a channel by id for the fallback walker. Returns `null` for a
 * missing or fully off channel so the walk stops rather than attempting it.
 */
export async function resolveChannel(id: string, planKey?: string): Promise<ChannelRow | null> {
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
  if (planKey !== undefined && (row.is_byok || row.sources?.modality !== 'chat' || !eligibleForPlan(row, planKey))) return null;
  return toChannelRow(row);
}

/** A request-priced channel, resolved for the media endpoints. */
export interface MediaChannelRow {
  /** Eligible same-model alternatives, present only for Auto. */
  fallbackChannels?: MediaChannelRow[];
  id: string;
  provider: Provider;
  baseUrl: string | null;
  modelId: string;
  creditMultiplier: string;
  /** USD charged per completed job; never null on a request-priced row. */
  requestPriceUsd: number;
  billingPolicy?: BillingPolicy;
}

/**
 * Picks the media channel a caller addressed by `publicModelId`.
 *
 * The request-priced sibling of {@link selectChannelByModel}, sharing its
 * ranking, its source-preference cascade and its refusal to distinguish "no
 * such model" from "your plan cannot reach it". BYOK is excluded: a render job
 * is billed on completion by a callback that arrives long after the request,
 * and a caller's own key has no hold to settle against.
 *
 * `kind` is matched against the channel's task rather than trusted from the
 * caller, so asking `/v1/videos` for an image model is a 404 rather than an
 * image billed as a video.
 */
export async function selectMediaChannel(
  publicModelId: string,
  planKey: string,
  kind: 'image' | 'video',
  preferences: RoutingPreferences = new Map(),
): Promise<MediaChannelRow | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select(PLATFORM_COLUMNS)
    .eq('public_model_id', publicModelId)
    .eq('task', `${kind}.generate`)
    .neq('status', 'off')
    .eq('is_byok', false);

  if (error !== null) {
    throw new Error(`media channel lookup failed: ${error.message}`);
  }

  const eligible = channelRowSchema
    .array()
    .parse(data ?? [])
    .filter((row) => !row.is_byok && row.sources?.modality === kind &&
      row.request_price_usd !== null && eligibleForPlan(row, planKey, 'request'));

  const best = preferredOf(eligible, preferences, kind);
  if (best === null) return null;

  const row = eligible.find((candidate) => candidate.id === best.id);
  // `channels_request_price_present` makes this unreachable from a well-formed
  // row; refusing beats routing a job that would settle at zero credits.
  if (row === undefined || row.request_price_usd === null) return null;

  const selected = toMediaChannel(row);
  if (!preferences.has(routingKey(row.sources!.family, kind))) {
    selected.fallbackChannels = rankRows(eligible.filter((candidate) =>
      candidate.id !== row.id && candidate.sources?.family === row.sources!.family,
    )).sort((a, b) => Number(b.sources?.is_default) - Number(a.sources?.is_default))
      .slice(0, MAX_CHAIN_DEPTH - 1).map(toMediaChannel);
  }
  return selected;
}

function toMediaChannel(row: ChannelDbRow): MediaChannelRow {
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.base_url,
    modelId: row.model_id,
    creditMultiplier: sourceSchema.parse(row.sources).credit_multiplier,
    requestPriceUsd: row.request_price_usd!,
    ...(row.billing_policy ? { billingPolicy: row.billing_policy } : {}),
  };
}

/**
 * Every media model of `kind` that `planKey` may reach, sorted for a stable
 * list. The request-priced sibling of {@link listPublicModels}, and it applies
 * exactly the same eligibility and source cascade as {@link selectMediaChannel}
 * so the picker can never offer a model the dispatcher would refuse.
 */
export async function listMediaModels(
  planKey: string,
  kind: 'image' | 'video',
  preferences: RoutingPreferences = new Map(),
): Promise<string[]> {
  const { data, error } = await createServiceClient()
    .from('channels')
    .select(PLATFORM_COLUMNS)
    .eq('task', `${kind}.generate`)
    .not('public_model_id', 'is', null)
    .neq('status', 'off')
    .eq('is_byok', false);
  if (error !== null) throw new Error(`media model lookup failed: ${error.message}`);

  const rows = channelRowSchema
    .array()
    .parse(data ?? [])
    .filter((row) => eligibleForPlan(row, planKey, 'request') && row.request_price_usd !== null);

  return [
    ...new Set(rows.flatMap((row) => (row.public_model_id === null ? [] : [row.public_model_id]))),
  ]
    .filter(
      (id) =>
        preferredOf(
          rows.filter((row) => row.public_model_id === id),
          preferences,
          kind,
        ) !== null,
    )
    .sort();
}
