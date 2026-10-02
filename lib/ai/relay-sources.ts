import type { Sql } from 'postgres';
import { z } from 'zod';

import {
  billingPolicySchema,
  scaleTiers,
  type BillingPolicy,
  type SourcePricing,
} from '@/lib/ai/billing-policy';
import { PROVIDER_ENDPOINT_PATH, PROVIDERS } from '@/lib/ai/providers';
import { RELAY_BASE_URL } from '@/lib/ai/relay-catalog';
import type { Logger } from '@/lib/log';

/**
 * Keeps Relay chat prices in step with the source selected in the Relay
 * account.
 *
 * Relay bills a family at the unit price of the account's selected source
 * (GPT Plus/Pro, Claude Max, ...), times the model's billing multiplier. The
 * public catalog only publishes the default source, so an imported rate is
 * right only until someone switches source in the Relay dashboard. Each sync
 * reads the selection from the routing profile and what Relay actually billed
 * from the usage log, then rewrites the rates of every Relay chat channel.
 *
 * Relay's listed source prices and its billing have been seen to disagree
 * (a price change listed as effective days before billing followed it), so the
 * price used is the higher of the two. The platform never charges less than
 * Relay bills; it can charge more until billing catches up with the listing.
 */

const RELAY_ORIGIN = new URL(RELAY_BASE_URL).origin;
/** Rows priced by a sync older than this are withheld from routing. */
export const RELAY_PRICING_MAX_AGE_MS = 10 * 60_000;
/** Billed observations older than this no longer vouch for a price. */
const OBSERVATION_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Families whose source the account chooses; the rest have exactly one source. */
const SELECTABLE = { gpt: 'gpt_routing', claude: 'claude_routing', grok: 'grok_routing' } as const;

const relaySourceSchema = z.object({
  tier: z.string(),
  family: z.string(),
  label: z.string(),
  status: z.string(),
  unit_price_numerator: z.number().positive(),
  unit_price_denominator: z.number().positive(),
});
const routingSchema = z.object({
  tier: z.string(),
  sources: z.array(relaySourceSchema),
  max_supported_paths: z.array(z.string()).optional(),
});
export const relayProfileSchema = z.object({
  success: z.literal(true),
  data: z.object({
    gpt_routing: routingSchema,
    claude_routing: routingSchema,
    grok_routing: routingSchema,
    sources: z.array(relaySourceSchema),
  }),
});
export type RelayProfile = z.infer<typeof relayProfileSchema>['data'];

const logOtherSchema = z.object({
  routing_tier: z.string().optional(),
  group_ratio: z.number().positive().optional(),
});
export const relayLogPageSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(z.object({
      created_at: z.number(),
      model_name: z.string(),
      other: z.string().optional().default(''),
    })),
  }),
});
export type RelayLogItem = z.infer<typeof relayLogPageSchema>['data']['items'][number];

export interface ActiveSource {
  tier: string;
  label: string;
  unitPrice: number;
  /**
   * The family's other live sources (tier to label), for a family Relay
   * serves from several without a selector. Relay bills the cheapest and falls
   * back to these, so a bill observed on one of them vouches for the price.
   */
  fallbacks?: Record<string, string>;
}

/** What Relay last billed a model at: its group ratio, billing multiplier included. */
export interface Observation {
  tier: string;
  groupRatio: number;
  at: number;
}

/**
 * The source Relay bills each family at, for a request on `requestPath`.
 * Claude Max applies only to the request paths it lists; anything else stays
 * on Kiro, Relay's default Claude source.
 */
export function activeSources(profile: RelayProfile, requestPath: string): Map<string, ActiveSource> {
  const result = new Map<string, ActiveSource>();
  const toActive = (source: z.infer<typeof relaySourceSchema>): ActiveSource => ({
    tier: source.tier,
    label: source.label,
    unitPrice: source.unit_price_numerator / source.unit_price_denominator,
  });
  for (const [family, key] of Object.entries(SELECTABLE)) {
    const routing = profile[key];
    let tier = routing.tier;
    if (family === 'claude' && tier === 'max' && routing.max_supported_paths && !routing.max_supported_paths.includes(requestPath)) {
      tier = 'kiro';
    }
    const source = routing.sources.find((candidate) => candidate.tier === tier);
    if (!source) throw new Error(`Relay ${family} source ${tier} is not in its source list`);
    result.set(family, toActive(source));
  }
  const fixed = new Map<string, z.infer<typeof relaySourceSchema>[]>();
  for (const source of profile.sources) {
    if (source.family in SELECTABLE || source.status !== 'active') continue;
    fixed.set(source.family, [...(fixed.get(source.family) ?? []), source]);
  }
  for (const [family, sources] of fixed) {
    // Since 2026-09-30 Gemini, DeepSeek, GLM and Kimi each list a standard
    // source plus pricier reserve and last-resort ones, with no selector. The
    // cheapest is the family price Relay publishes and the one its usage log
    // bills; the others are fallbacks, priced when a bill shows them in use
    // (see repriceSource). Ties go to the one named standard.
    const [primary, ...rest] = [...sources].sort((a, b) =>
      a.unit_price_numerator / a.unit_price_denominator - b.unit_price_numerator / b.unit_price_denominator ||
      Number(b.tier.endsWith('-standard')) - Number(a.tier.endsWith('-standard')) ||
      a.tier.localeCompare(b.tier));
    result.set(family, rest.length
      ? { ...toActive(primary!), fallbacks: Object.fromEntries(rest.map((s) => [s.tier, s.label])) }
      : toActive(primary!));
  }
  return result;
}

/** Newest billed ratio per model, merged over earlier observations. */
export function mergeObservations(
  previous: Record<string, Observation>,
  items: readonly RelayLogItem[],
  now: Date,
): Record<string, Observation> {
  const merged: Record<string, Observation> = {};
  for (const [model, observation] of Object.entries(previous)) {
    if (now.getTime() - observation.at * 1000 <= OBSERVATION_MAX_AGE_MS) merged[model] = observation;
  }
  for (const item of items) {
    let other: unknown;
    try {
      other = JSON.parse(item.other || '{}');
    } catch {
      continue;
    }
    const parsed = logOtherSchema.safeParse(other);
    if (!parsed.success || !parsed.data.routing_tier || !parsed.data.group_ratio) continue;
    const known = merged[item.model_name];
    if (known && known.at >= item.created_at) continue;
    if (now.getTime() - item.created_at * 1000 > OBSERVATION_MAX_AGE_MS) continue;
    merged[item.model_name] = { tier: parsed.data.routing_tier, groupRatio: parsed.data.group_ratio, at: item.created_at };
  }
  return merged;
}

/**
 * Source pricing for a channel under the current Relay selection: the listed
 * source price, raised to what Relay last billed this model on the same source
 * or on one of its fallbacks.
 */
export function repriceSource(
  current: SourcePricing,
  source: ActiveSource,
  observation: Observation | undefined,
): SourcePricing {
  const listed = source.unitPrice * current.billingMultiplier;
  const fallbackLabel = observation ? source.fallbacks?.[observation.tier] : undefined;
  const billed = observation && (observation.tier === source.tier || fallbackLabel !== undefined) ? observation.groupRatio : 0;
  // A fallback that billed above the primary is the source actually in use.
  const onFallback = fallbackLabel !== undefined && billed > listed;
  return {
    ...current,
    scale: Number((Math.max(listed, billed) / current.factor).toPrecision(12)),
    tier: onFallback ? observation!.tier : source.tier,
    label: onFallback ? fallbackLabel : source.label,
  };
}

export function repricedPolicy(policy: BillingPolicy, sourcePricing: SourcePricing): BillingPolicy {
  return { ...policy, tiers: scaleTiers(sourcePricing.baseTiers, sourcePricing.scale), sourcePricing };
}

const channelRowSchema = z.object({
  id: z.string(),
  model_id: z.string(),
  provider: z.enum(PROVIDERS),
  billing_policy: billingPolicySchema.nullable(),
});

export interface RelaySyncResult {
  sources: Record<string, ActiveSource>;
  repriced: { id: string; from: number; to: number; tier: string }[];
  unchanged: number;
}

async function relayGet(path: string, token: string, userId: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(`${RELAY_ORIGIN}${path}`, {
    headers: { authorization: `Bearer ${token}`, 'New-Api-User': userId },
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Relay ${path.split('?')[0]} HTTP ${response.status}`);
  return body;
}

const stateSchema = z.object({ observed: z.record(z.string(), z.object({ tier: z.string(), groupRatio: z.number(), at: z.number() })).default({}) }).passthrough();

/**
 * One sync: read the Relay selection and recent billing, reprice every Relay
 * chat channel that needs it, and record the result on the `relay.fast`
 * routing provider. A failure is recorded without advancing the sync time, so
 * the rows it would have priced are withheld once the last good sync ages out.
 */
export async function syncRelaySources(options: {
  sql: Sql;
  token: string;
  userId: string;
  log: Logger;
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Compute the new prices without writing them or recording a sync. */
  dryRun?: boolean;
}): Promise<RelaySyncResult> {
  const { sql, token, userId, log, fetchImpl = fetch, now = new Date(), dryRun = false } = options;
  try {
    const [profileBody, logBody] = await Promise.all([
      relayGet('/api/routing/profile', token, userId, fetchImpl),
      relayGet('/api/log/self?p=1&page_size=100&type=2', token, userId, fetchImpl),
    ]);
    const profile = relayProfileSchema.parse(profileBody).data;
    const items = relayLogPageSchema.parse(logBody).data.items;

    const result = await sql.begin(async (tx) => {
      // On 2026-10-02 a reply lost on the pooler connection left this
      // transaction idle with the lock held; the next tick never started and
      // every Relay chat channel aged out of routing. Bound every wait so a
      // dead connection fails the sync instead of stalling it.
      await tx`SELECT set_config('idle_in_transaction_session_timeout', '30s', true),
        set_config('lock_timeout', '15s', true), set_config('statement_timeout', '30s', true)`;
      // One sync at a time, so two processes cannot interleave repricing.
      await tx`SELECT pg_advisory_xact_lock(hashtext('relay-source-sync'))`;
      const [provider] = await tx`SELECT upstream_state FROM routing_providers WHERE id = 'relay.fast' FOR UPDATE`;
      const previous = stateSchema.safeParse(provider?.upstream_state ?? {});
      const observed = mergeObservations(previous.success ? previous.data.observed : {}, items, now);
      const rows = z.array(channelRowSchema).parse(await tx`
        SELECT id, model_id, provider, billing_policy FROM channels
        WHERE base_url = ${RELAY_BASE_URL} AND pricing_type = 'token' FOR UPDATE`);

      const outcome: RelaySyncResult = { sources: {}, repriced: [], unchanged: 0 };
      for (const row of rows) {
        const current = row.billing_policy?.sourcePricing;
        if (!row.billing_policy || !current) continue;
        const source = activeSources(profile, `/v1${PROVIDER_ENDPOINT_PATH[row.provider]}`).get(current.relayFamily);
        if (!source) throw new Error(`Relay has no active ${current.relayFamily} source for ${row.id}`);
        outcome.sources[current.relayFamily] = source;
        const next = repriceSource(current, source, observed[row.model_id]);
        if (next.scale === current.scale && next.tier === current.tier && next.label === current.label) {
          outcome.unchanged += 1;
          continue;
        }
        outcome.repriced.push({ id: row.id, from: current.scale, to: next.scale, tier: next.tier! });
        if (dryRun) continue;
        const policy = repricedPolicy(row.billing_policy, next);
        const rates = policy.tiers[0]!.rates;
        await tx`UPDATE channels SET billing_policy = ${tx.json(policy as never)},
            input_per_mtok = ${rates.inputPerMTok}, output_per_mtok = ${rates.outputPerMTok},
            cached_per_mtok = ${rates.cachedPerMTok}, updated_at = now()
          WHERE id = ${row.id}`;
      }
      if (dryRun) return outcome;
      const state = { sources: outcome.sources, observed };
      await tx`INSERT INTO routing_providers (id, upstream_state, upstream_synced_at, upstream_error)
        VALUES ('relay.fast', ${tx.json(state as never)}, ${now}, NULL)
        ON CONFLICT (id) DO UPDATE SET upstream_state = EXCLUDED.upstream_state,
          upstream_synced_at = EXCLUDED.upstream_synced_at, upstream_error = NULL`;
      return outcome;
    });
    if (!dryRun) for (const change of result.repriced) log.info('relay_sources.repriced', change);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('relay_sources.sync_failed', { error: message });
    if (dryRun) throw error;
    await sql`INSERT INTO routing_providers (id, upstream_error) VALUES ('relay.fast', ${message.slice(0, 500)})
      ON CONFLICT (id) DO UPDATE SET upstream_error = EXCLUDED.upstream_error`.catch(() => undefined);
    throw error;
  }
}
