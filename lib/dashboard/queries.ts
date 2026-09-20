import { z } from 'zod';
import { PROVIDERS, type Provider } from '@/lib/ai/providers';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { isPlanKey, type PlanKey } from '@/lib/billing/plans';
import { costUsd, creditsForUsage, type TokenRates } from '@/lib/ai/pricing';

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
  channel_id: z.string(),
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
  model_id: z.string(),
  status: z.string(),
});
export type ChannelInfo = z.infer<typeof channelInfoRowSchema>;

const modelCatalogRowSchema = z.object({
  public_model_id: z.string(),
  label: z.string(),
  provider: z.enum(PROVIDERS),
  model_id: z.string(),
  status: z.string(),
  min_plan: z.string(),
  // numeric(10,2) arrives as a string; the catalog only displays it, so a
  // Number here is safe where the billing path deliberately keeps the string.
  credit_multiplier: numeric,
  input_per_mtok: numeric,
  output_per_mtok: numeric,
  cached_per_mtok: numeric,
});

export interface ModelCatalogEntry {
  publicModelId: string;
  label: string;
  provider: Provider;
  /** The real upstream model string. Never exposed to API callers. */
  upstreamModelId: string;
  status: string;
  minPlan: PlanKey;
  /** 0 means BYOK-only: the channel bills the caller's own key, not credits. */
  creditMultiplier: number;
  inputCreditsPerMTok: number;
  outputCreditsPerMTok: number;
  cachedCreditsPerMTok: number;
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
      'request_id, channel_id, input_tokens, output_tokens, cached_tokens, latency_ms, status, cost_usd, credits_charged, created_at',
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
  return z.array(usageEventRowSchema).parse(data);
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
        .select('id, label, task, provider, model_id, status')
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
      'public_model_id, label, provider, model_id, status, min_plan, credit_multiplier, input_per_mtok, output_per_mtok, cached_per_mtok',
    )
    .not('public_model_id', 'is', null)
    .neq('status', 'off');
  if (error) fail('models', error.message);

  return z
    .array(modelCatalogRowSchema)
    .parse(data)
    .map((row) => {
      const rates: TokenRates = {
        inputPerMTok: row.input_per_mtok,
        outputPerMTok: row.output_per_mtok,
        cachedPerMTok: row.cached_per_mtok,
      };
      const multiplier = Number(row.credit_multiplier);

      return {
        publicModelId: row.public_model_id,
        label: row.label,
        provider: row.provider,
        upstreamModelId: row.model_id,
        status: row.status,
        minPlan: isPlanKey(row.min_plan) ? row.min_plan : 'free',
        creditMultiplier: multiplier,
        // Credits for a full million tokens of each kind, which is how the
        // rates are quoted — per-call figures round up to 1 and say nothing.
        inputCreditsPerMTok: creditsPerMTok(rates, 'inputTokens', multiplier),
        outputCreditsPerMTok: creditsPerMTok(rates, 'outputTokens', multiplier),
        cachedCreditsPerMTok: creditsPerMTok(rates, 'cachedTokens', multiplier),
      };
    })
    .sort((left, right) => left.publicModelId.localeCompare(right.publicModelId));
}
