import {
  sourceSchema,
  SOURCE_COLUMNS,
  type Family,
  type Modality,
} from '@/lib/ai/sources';
import { z } from 'zod';
import { billingPolicySchema, policyRates, publicBillingPolicy, type PublicBillingPolicy } from '@/lib/ai/billing-policy';
import { PROVIDERS, type Provider } from '@/lib/ai/providers';
import { publicRoutingProviderIdentity, publicRoutingSourceLabel, publicRoutingTags, publicRoutingText, type RoutingProviderIdentity } from '@/lib/ai/routing-provider';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { isPlanKey, planMeetsMinimum, type PlanKey } from '@/lib/billing/plans';
import { costUsd, creditsForUsage, type TokenRates } from '@/lib/ai/pricing';
import { routingPriceChanges, type RoutingPriceHistoryEntry } from './routing-history';
import { requestPriceKind } from './public-prices';

/**
 * Read helpers for the developer dashboard.
 *
 * supabase-js is untyped here (no generated `Database` type), so every row is
 * parsed with Zod rather than asserted — an unexpected shape must fail loudly
 * instead of rendering `undefined` next to a credit figure.
 *
 * Reads use the SESSION client (RLS-scoped to the signed-in user) except
 * `provider_credentials`, which has RLS enabled with zero policies and no
 * `authenticated` grant: it is server-only and therefore read with the service
 * client, explicitly filtered by `owner_id`.
 */

/** bigint/numeric arrive as either JSON numbers or strings depending on the column. */
const numeric = z.coerce.number();
const nullableNumeric = z.union([z.null(), numeric]);

export const apiKeyRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  last_four: z.string(),
  status: z.string(),
  last_used_at: z.string().nullable(),
  created_at: z.string(),
  rate_limit_rpm: numeric,
});
export type ApiKeyRow = z.infer<typeof apiKeyRowSchema>;

export const ledgerRowSchema = z.object({
  id: numeric,
  request_id: z.string(),
  kind: z.string(),
  credits: numeric,
  channel_id: z.string().nullable(),
  created_at: z.string(),
});
export type LedgerRow = z.infer<typeof ledgerRowSchema>;

export const usageEventRowSchema = z.object({
  request_id: z.string(),
  // Moderation rejects before channel selection; keep the UI's empty-id sentinel.
  channel_id: z
    .string()
    .nullable()
    .transform((value) => value ?? ''),
  source_label: z.string().nullable(),
  input_tokens: nullableNumeric,
  output_tokens: nullableNumeric,
  cached_tokens: nullableNumeric,
  latency_ms: nullableNumeric,
  status: z.string(),
  cost_usd: nullableNumeric,
  credits_charged: nullableNumeric,
  created_at: z.string(),
});
export type UsageEventRow = z.infer<typeof usageEventRowSchema>;

/** Public channel metadata used to give usage rows a readable model/provider label. */
export const channelInfoRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  task: z.string(),
  provider: z.enum(PROVIDERS),
  model_id: z
    .string()
    .nullable()
    .transform((v) => v ?? 'Internal task'),
  status: z.string(),
});
export type ChannelInfo = z.infer<typeof channelInfoRowSchema>;

const modelCatalogRowSchema = z.object({
  base_url: z.string().nullish(),
  billing_policy: billingPolicySchema.nullish(),
  id: z.string(),
  public_model_id: z.string(),
  pricing_type: z.enum(['token', 'request']),
  request_price_usd: z
    .union([z.string(), z.number()])
    .nullable()
    .optional()
    .transform((v) => (v === null || v === undefined ? null : Number(v))),
  label: z.string(),
  provider: z.enum(PROVIDERS),
  model_id: z.string(),
  status: z.string(),
  min_plan: z.string(),
  // numeric(10,2) arrives as a string; the catalog only displays it, so a
  // Number here is safe where the billing path deliberately keeps the string.
  is_byok: z.boolean(),
  source_id: z.string().nullable(),
  sources: sourceSchema.nullable(),
  input_per_mtok: numeric,
  output_per_mtok: numeric,
  cached_per_mtok: numeric,
});

export interface ModelCatalogEntry {
  routingProvider?: RoutingProviderIdentity;
  billingPolicy?: PublicBillingPolicy | null;
  id: string;
  sourceId: string | null;
  sourceLabel: string;
  sourceDescription: string;
  family: Family | null;
  /** From the source: what this channel produces. */
  modality: Modality;
  publicModelId: string;
  label: string;
  provider: Provider;
  /** The real upstream model string. Never exposed to API callers. */
  upstreamModelId: string;
  status: string;
  minPlan: PlanKey;
  /** BYOK bills the caller's own key; the multiplier is only a price. */
  isByok: boolean;
  creditMultiplier: number;
  inputCreditsPerMTok: number;
  outputCreditsPerMTok: number;
  cachedCreditsPerMTok: number;
  /** Credits for one completed job. Null for token-priced models. */
  requestCredits: number | null;
  requestPriceKind?: import('./public-prices').RequestPriceKind | null;
}

/** Credits charged for one million tokens of a single kind, markup included. */
function creditsPerMTok(
  rates: TokenRates,
  kind: 'inputTokens' | 'outputTokens' | 'cachedTokens',
  multiplier: number,
): number {
  const usage = {
    inputTokens: kind === 'inputTokens' ? 1_000_000 : 0,
    outputTokens: kind === 'outputTokens' ? 1_000_000 : 0,
    cachedTokens: kind === 'cachedTokens' ? 1_000_000 : 0,
  };
  return creditsForUsage(costUsd(rates, usage), multiplier);
}

export const credentialRowSchema = z.object({
  id: z.string(),
  provider: z.string(),
  base_url: z.string().nullable(),
  last_four: z.string(),
  status: z.string(),
  created_at: z.string(),
});
export type CredentialRow = z.infer<typeof credentialRowSchema>;

const entitlementRowSchema = z.object({
  plan_key: z.string(),
  status: z.string(),
  current_period_end: z.string().nullable(),
  monthly_credits: numeric,
});

export interface Entitlement {
  planKey: PlanKey;
  status: string;
  currentPeriodEnd: string | null;
  monthlyCredits: number;
}

function fail(what: string, message: string): never {
  throw new Error(`dashboard: failed to load ${what}: ${message}`);
}

/** Current credit balance via the client-callable, RLS-scoped `my_balance()` RPC. */
export async function getBalance(): Promise<number> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('my_balance');
  if (error) fail('balance', error.message);
  return numeric.parse(data);
}

export async function getEntitlement(userId: string): Promise<Entitlement> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('entitlements')
    .select('plan_key, status, current_period_end, monthly_credits')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) fail('entitlement', error.message);

  // The signup trigger inserts a row for every user, but a user created out of
  // band would have none — treat that as the free default rather than erroring.
  if (data === null) {
    return { planKey: 'free', status: 'inactive', currentPeriodEnd: null, monthlyCredits: 0 };
  }

  const row = entitlementRowSchema.parse(data);
  return {
    planKey: isPlanKey(row.plan_key) ? row.plan_key : 'free',
    status: row.status,
    currentPeriodEnd: row.current_period_end,
    monthlyCredits: row.monthly_credits,
  };
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, key_prefix, last_four, status, last_used_at, created_at, rate_limit_rpm')
    .order('created_at', { ascending: false });
  if (error) fail('api keys', error.message);
  return z.array(apiKeyRowSchema).parse(data);
}

export async function listLedger(
  options: { limit: number; beforeId?: number | undefined } = { limit: 10 },
): Promise<LedgerRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from('ledger')
    .select('id, request_id, kind, credits, channel_id, created_at')
    .order('id', { ascending: false })
    .limit(options.limit);
  if (options.beforeId !== undefined) {
    query = query.lt('id', options.beforeId);
  }
  const { data, error } = await query;
  if (error) fail('ledger', error.message);
  return z.array(ledgerRowSchema).parse(data);
}

export interface UsageFilter {
  from?: string | undefined;
  to?: string | undefined;
  status?: string | undefined;
  limit: number;
}

function nextUtcDay(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString();
}

export async function listUsageEvents(filter: UsageFilter): Promise<UsageEventRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from('usage_events')
    .select(
      'request_id, channel_id, source_label, input_tokens, output_tokens, cached_tokens, latency_ms, status, cost_usd, credits_charged, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(filter.limit);

  if (filter.from !== undefined) query = query.gte('created_at', `${filter.from}T00:00:00.000Z`);
  // `to` is a calendar date from the form, so use the following UTC midnight
  // as an exclusive boundary and include the complete selected day.
  if (filter.to !== undefined) query = query.lt('created_at', nextUtcDay(filter.to));
  if (filter.status !== undefined) query = query.eq('status', filter.status);

  const { data, error } = await query;
  if (error) fail('usage events', error.message);
  return z.array(usageEventRowSchema).parse(data).map((row) => ({
    ...row,
    source_label: publicRoutingSourceLabel(row.source_label),
  }));
}

/**
 * Channel metadata is service-only, so only resolve IDs already present in the
 * signed-in user's RLS-scoped usage or ledger history.
 */
export async function listChannelInfo(channelIds: readonly string[]): Promise<ChannelInfo[]> {
  const ids = [...new Set(channelIds.filter((id) => id.trim() !== ''))];
  if (ids.length === 0) return [];

  const service = createServiceClient();
  const batches: string[][] = [];
  const batchSize = 100;
  for (let index = 0; index < ids.length; index += batchSize) {
    batches.push(ids.slice(index, index + batchSize));
  }

  const responses = await Promise.all(
    batches.map(async (batch) => {
      const { data, error } = await service
        .from('channels')
        .select('id, label, task, provider, model_id:public_model_id, status')
        .in('id', batch);
      if (error) fail('channels', error.message);
      return z.array(channelInfoRowSchema).parse(data);
    }),
  );

  return responses.flat().sort((left, right) => left.label.localeCompare(right.label));
}

/** Server-only table: no client grant exists, so this uses the service client. */
export async function listCredentials(userId: string): Promise<CredentialRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('provider_credentials')
    .select('id, provider, base_url, last_four, status, created_at')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false });
  if (error) fail('credentials', error.message);
  return z.array(credentialRowSchema).parse(data);
}

/**
 * Every addressable model on the gateway, whatever the caller's plan.
 *
 * Only channels with a `public_model_id` are listed: the rest are internal
 * site-spec channels with no name a caller could pass as `"model"`. Fully off
 * channels are hidden, but ones above the user's plan are not — the page shows
 * them as locked so upgrading has something to point at.
 *
 * Channel rows are service-only (no client grant), so this reads with the
 * service client and selects nothing that is not already public via
 * `GET /v1/models` plus published pricing.
 */
export async function listModelCatalog(): Promise<ModelCatalogEntry[]> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select(
      'id, public_model_id, pricing_type, request_price_usd, billing_policy, label, provider, base_url, model_id, status, min_plan, is_byok, source_id, input_per_mtok, output_per_mtok, cached_per_mtok, sources(' +
        SOURCE_COLUMNS +
        ')',
    )
    .not('public_model_id', 'is', null)
    .neq('status', 'off');
  if (error) fail('models', error.message);

  // Request-priced rows are listed now that the media endpoints dispatch them.
  // They were excluded while nothing could bill per job.
  return z
    .array(modelCatalogRowSchema)
    .parse(data)
    .filter((row) => row.is_byok || (row.sources !== null && row.sources.status !== 'off'))
    .map((row) => {
      const currentRates = row.billing_policy ? policyRates(row.billing_policy) : null;
      const rates: TokenRates = {
        inputPerMTok: currentRates?.inputPerMTok ?? row.input_per_mtok,
        outputPerMTok: currentRates?.outputPerMTok ?? row.output_per_mtok,
        cachedPerMTok: currentRates?.cachedPerMTok ?? row.cached_per_mtok,
      };
      const multiplier = row.is_byok
        ? 0
        : Number(sourceSchema.parse(row.sources).credit_multiplier);

      return {
        id: row.id,
        routingProvider: publicRoutingProviderIdentity({
          baseUrl: row.is_byok ? null : row.base_url, provider: row.provider,
          sourceId: row.source_id, sourceLabel: row.sources?.label,
        }),
        billingPolicy: publicBillingPolicy(row.billing_policy),
        sourceId: row.source_id,
        sourceLabel: row.is_byok
          ? 'BYOK'
          : publicRoutingProviderIdentity({
              sourceId: row.source_id,
              sourceLabel: row.sources?.label,
              provider: row.provider,
            }).label,
        sourceDescription: row.sources?.description ?? '',
        family: row.sources?.family ?? null,
        modality: row.sources?.modality ?? 'chat',
        publicModelId: row.public_model_id,
        label: publicRoutingText(row.label),
        provider: row.provider,
        upstreamModelId: row.model_id,
        status: row.sources?.status === 'degraded' ? 'degraded' : row.status,
        minPlan:
          row.sources !== null && planMeetsMinimum(row.sources.min_plan, row.min_plan)
            ? row.sources.min_plan
            : isPlanKey(row.min_plan)
              ? row.min_plan
              : 'free',
        creditMultiplier: multiplier,
        isByok: row.is_byok,
        // Credits for a full million tokens of each kind, which is how the
        // rates are quoted — per-call figures round up to 1 and say nothing.
        inputCreditsPerMTok: creditsPerMTok(rates, 'inputTokens', multiplier),
        outputCreditsPerMTok: creditsPerMTok(rates, 'outputTokens', multiplier),
        cachedCreditsPerMTok: creditsPerMTok(rates, 'cachedTokens', multiplier),
        requestCredits:
          row.pricing_type === 'request' && row.request_price_usd !== null
            ? creditsForUsage(row.request_price_usd, multiplier)
            : null,
        requestPriceKind: row.pricing_type === 'request' ? requestPriceKind(row.provider, row.billing_policy) : null,
      };
    })
    .sort((left, right) => left.publicModelId.localeCompare(right.publicModelId));
}

const routingAuditRowSchema = z.object({
  id: numeric,
  action: z.string(),
  target: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  created_at: z.string(),
});

export type { RoutingPriceHistoryEntry } from './routing-history';

/** Recent audited price changes for the public models visible to this user. */
export async function listRoutingPriceHistory(
  models: readonly ModelCatalogEntry[],
  limit = 100,
): Promise<RoutingPriceHistoryEntry[]> {
  if (!models.length) return [];
  const service = createServiceClient();
  const count = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 200) : 100;
  const history: RoutingPriceHistoryEntry[] = [];
  // Filter after paging, so status/description edits cannot crowd actual
  // price changes out of a single limited audit result. ID is a stable cursor.
  let beforeId: number | undefined;
  let table = 'routing_price_history';
  while (history.length < count) {
    let query = service.from(table)
      .select('id, action, target, before, after, created_at')
      .in('action', ['source.update', 'channel.update'])
      .order('id', { ascending: false }).limit(200);
    if (beforeId !== undefined) query = query.lt('id', beforeId);
    const { data, error } = await query;
    // A rolling deploy can serve this page before the migration finishes.
    // Existing audit history remains usable until the dedicated table exists.
    if (error && table === 'routing_price_history' && ['42P01', 'PGRST205'].includes(error.code)) {
      table = 'admin_audit_log';
      continue;
    }
    if (error) fail('routing price history', error.message);
    const rows = z.array(routingAuditRowSchema).parse(data ?? []);
    for (const row of rows) history.push(...routingPriceChanges(row, models));
    if (rows.length < 200) break;
    beforeId = rows[rows.length - 1]!.id;
  }
  return history.slice(0, count);
}

/** One public price per provider, model and modality, using that provider's best route. */
export async function listPublicPrices(): Promise<import('./public-prices').PublicPrice[]> {
  const { data, error } = await createServiceClient()
    .from('channels')
    .select(
      'id, public_model_id, label, provider, base_url, status, priority, vendor, context_window, endpoints, tags, pricing_type, request_price_usd, billing_policy, input_per_mtok, output_per_mtok, cached_per_mtok, list_input_per_mtok, list_output_per_mtok, list_cached_per_mtok, sources!inner(' +
        SOURCE_COLUMNS +
        ')',
    )
    .not('public_model_id', 'is', null)
    .neq('status', 'off')
    .eq('is_byok', false);
  if (error) fail('public prices', error.message);
  const schema = z.object({
    billing_policy: billingPolicySchema.nullish(),
    provider: z.enum(PROVIDERS),
    base_url: z.string().nullable(),
    id: z.string(),
    public_model_id: z.string(),
    label: z.string(),
    status: z.string(),
    priority: numeric,
    vendor: z.string().nullable(),
    context_window: numeric.nullable(),
    endpoints: z.array(z.string()),
    tags: z.array(z.string()),
    pricing_type: z.enum(['token', 'request']),
    request_price_usd: numeric.nullable(),
    sources: sourceSchema,
    input_per_mtok: numeric,
    output_per_mtok: numeric,
    cached_per_mtok: numeric,
    list_input_per_mtok: numeric.nullable(),
    list_output_per_mtok: numeric.nullable(),
    list_cached_per_mtok: numeric.nullable(),
  });
  const rows = schema
    .array()
    .parse(data)
    .filter((row) => row.status !== 'off' && row.sources.status !== 'off')
    .sort(
      (a, b) =>
        Number(b.sources.is_default) - Number(a.sources.is_default) ||
        b.priority - a.priority ||
        Number(b.status === 'active' && b.sources.status === 'active') - Number(a.status === 'active' && a.sources.status === 'active') ||
        a.id.localeCompare(b.id),
    ).map((row) => ({
      ...row,
      routingProvider: publicRoutingProviderIdentity({ baseUrl: row.base_url, provider: row.provider, sourceId: row.sources.id, sourceLabel: row.sources.label }),
    }));
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = JSON.stringify([row.routingProvider.id, row.public_model_id, row.sources.modality]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => {
      const multiplier = Number(row.sources.credit_multiplier);
      const tokenPriced = row.pricing_type === 'token';
      const currentRates = row.billing_policy && tokenPriced ? policyRates(row.billing_policy) : null;
      const credits = (dollars: number) => creditsForUsage(dollars, multiplier);
      const list = (dollars: number | null) =>
        dollars === null ? null : creditsForUsage(dollars, 1);
      const imagePrices = row.billing_policy?.imagePrices;
      const requestUsd = imagePrices ? Math.min(imagePrices.standard, imagePrices.large) : row.request_price_usd;
      // Kie publishes its own serving rate here, not a separate model-maker
      // list price. Never present that duplicate as an independent discount.
      const hasVerifiedListPrice = row.routingProvider.id !== 'provider-b';
      return {
        model: row.public_model_id,
        billingPolicy: publicBillingPolicy(row.billing_policy),
        label: publicRoutingText(row.label),
        group: row.sources.family,
        vendor: publicRoutingText(row.vendor ?? 'Unknown'),
        contextWindow: row.context_window,
        endpoints: row.endpoints,
        tags: publicRoutingTags(row.tags),
        pricingType: row.pricing_type,
        modality: row.sources.modality,
        providerId: row.routingProvider.id,
        sourceLabel: row.routingProvider.label,
        multiplier,
        input: tokenPriced ? credits(currentRates?.inputPerMTok ?? row.input_per_mtok) : null,
        output: tokenPriced ? credits(currentRates?.outputPerMTok ?? row.output_per_mtok) : null,
        cached: tokenPriced ? credits(currentRates?.cachedPerMTok ?? row.cached_per_mtok) : null,
        request: !tokenPriced && requestUsd !== null ? credits(requestUsd) : null,
        requestPriceKind: tokenPriced ? null : requestPriceKind(row.provider, row.billing_policy),
        listInput: tokenPriced && hasVerifiedListPrice ? list(row.list_input_per_mtok) : null,
        listOutput: tokenPriced && hasVerifiedListPrice ? list(row.list_output_per_mtok) : null,
        listCached: tokenPriced && hasVerifiedListPrice ? list(row.list_cached_per_mtok) : null,
        // Only Relay's image importer explicitly stores a per-job reference here.
        listRequest: !tokenPriced && imagePrices ? list(row.list_input_per_mtok) : null,
      };
    });
}
