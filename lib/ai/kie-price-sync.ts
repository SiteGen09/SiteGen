import type { Sql } from 'postgres';
import { z } from 'zod';

import { billingPolicySchema, type BillingPolicy } from '@/lib/ai/billing-policy';
import { fetchKieModels, kieCatalogRows, type KieCatalog, type KieCatalogRow, type Kind } from '@/lib/ai/kie-catalog';
import type { Logger } from '@/lib/log';

/**
 * Keeps kie.ai channel prices equal to kie.ai's published catalogue.
 *
 * kie.ai prices each model publicly, so unlike Relay there is no account
 * setting to follow: the sync reads `/api/v1/models`, parses it exactly as the
 * importer does, and reprices every stored kie.ai channel whose price moved.
 * Price history records each change, and consumers are told through the
 * notification scanner.
 *
 * It only reprices. New models are left to the importer and missing ones are
 * reported, not switched off: offering or withdrawing a model is a decision.
 * A move too large to be plausible (more than 5x either way, or to zero) is
 * held for review rather than applied, because a misread price bills real
 * money and prose parsing can misread.
 */

const PLAUSIBLE_RATIO = 5;
const TASK_KIND: Record<string, Kind> = { 'chat.completions': 'chat', 'image.generate': 'image', 'video.generate': 'video' };

export const storedKieChannelSchema = z.object({
  id: z.string(),
  model_id: z.string(),
  task: z.string(),
  status: z.string(),
  pricing_type: z.enum(['token', 'request']),
  input_per_mtok: z.coerce.number(),
  output_per_mtok: z.coerce.number(),
  cached_per_mtok: z.coerce.number(),
  request_price_usd: z.coerce.number().nullable(),
  billing_policy: billingPolicySchema.nullable(),
});
export type StoredKieChannel = z.infer<typeof storedKieChannelSchema>;

export interface KieRepricing {
  id: string;
  kind: Kind;
  from: number[];
  to: number[];
  /** The new rates, ready to write. */
  next: { inputPerMTok: number; outputPerMTok: number; cachedPerMTok: number; requestPriceUsd: number | null };
}

export interface KiePlan {
  updates: KieRepricing[];
  review: { id: string; reason: string }[];
  missing: string[];
  unchanged: number;
}

const moved = (a: number, b: number) => Math.abs(a - b) > Math.max(a, b) * 0.005;
const implausible = (from: number, to: number) =>
  from > 0 && (to <= 0 || to / from > PLAUSIBLE_RATIO || from / to > PLAUSIBLE_RATIO);

/** What the stored channel charges now: the single policy tier when it has one, else its columns. */
function currentChat(channel: StoredKieChannel): number[] | null {
  const policy = channel.billing_policy;
  if (policy) {
    if (policy.tiers.length !== 1 || policy.peakUtcHours || policy.contextThreshold !== undefined) return null;
    const rates = policy.tiers[0]!.rates;
    return [rates.inputPerMTok, rates.outputPerMTok, rates.cachedPerMTok];
  }
  return [channel.input_per_mtok, channel.output_per_mtok, channel.cached_per_mtok];
}

export function planKieRepricing(stored: StoredKieChannel[], catalog: KieCatalog): KiePlan {
  const byId = new Map(catalog.rows.map((row) => [row.id, row]));
  const byModel = new Map(catalog.rows.map((row) => [`${row.kind}:${row.upstreamModel}`, row]));
  const untrusted = new Set(catalog.mismatched.map((line) => line.slice(0, line.indexOf(':'))));
  const plan: KiePlan = { updates: [], review: [], missing: [], unchanged: 0 };

  for (const channel of stored) {
    const kind = TASK_KIND[channel.task];
    const row: KieCatalogRow | undefined = byId.get(channel.id) ?? (kind ? byModel.get(`${kind}:${channel.model_id}`) : undefined);
    if (!kind || !row || row.kind !== kind) {
      if (channel.status !== 'off') plan.missing.push(channel.id);
      continue;
    }
    if (untrusted.has(row.upstreamModel)) {
      plan.review.push({ id: channel.id, reason: 'kie.ai text states a different dollar price than its credit price' });
      continue;
    }
    if (kind === 'chat') {
      const from = currentChat(channel);
      if (from === null) {
        plan.review.push({ id: channel.id, reason: 'tiered or time-based pricing is not synced automatically' });
        continue;
      }
      const to = [row.inputPerMTok, row.outputPerMTok, row.cachedPerMTok];
      if (!from.some((value, index) => moved(value, to[index]!))) {
        plan.unchanged += 1;
        continue;
      }
      // Cache reads priced at zero were an importer gap, so a first cache price is not a jump.
      if (implausible(from[0]!, to[0]!) || implausible(from[1]!, to[1]!)) {
        plan.review.push({ id: channel.id, reason: `implausible move ${from.join('/')} → ${to.join('/')} per 1M tokens` });
        continue;
      }
      plan.updates.push({
        id: channel.id, kind, from, to,
        next: { inputPerMTok: to[0]!, outputPerMTok: to[1]!, cachedPerMTok: to[2]!, requestPriceUsd: null },
      });
      continue;
    }
    const from = channel.request_price_usd ?? 0;
    const to = row.requestPriceUsd ?? 0;
    if (channel.billing_policy?.imagePrices) {
      plan.review.push({ id: channel.id, reason: 'tiered image pricing is not synced automatically' });
      continue;
    }
    if (!moved(from, to)) {
      plan.unchanged += 1;
      continue;
    }
    if (from <= 0 || implausible(from, to)) {
      plan.review.push({ id: channel.id, reason: `implausible move $${from} → $${to} per request` });
      continue;
    }
    plan.updates.push({ id: channel.id, kind, from: [from], to: [to], next: { inputPerMTok: 0, outputPerMTok: 0, cachedPerMTok: 0, requestPriceUsd: to } });
  }
  return plan;
}

function repricedPolicy(policy: BillingPolicy, next: KieRepricing['next'], now: Date): BillingPolicy {
  const tier = policy.tiers[0]!;
  return {
    ...policy,
    syncedAt: now.toISOString(),
    tiers: [{ ...tier, rates: { ...tier.rates, inputPerMTok: next.inputPerMTok, outputPerMTok: next.outputPerMTok, cachedPerMTok: next.cachedPerMTok } }],
  };
}

/** One sync: fetch kie.ai's catalogue, reprice what moved, and record the outcome on the kie.ai routing provider. */
export async function syncKiePrices(options: {
  sql: Sql;
  apiKey: string;
  log: Logger;
  fetchImpl?: typeof fetch;
  now?: Date;
  dryRun?: boolean;
}): Promise<KiePlan> {
  const { sql, apiKey, log, fetchImpl = fetch, now = new Date(), dryRun = false } = options;
  try {
    const catalog = kieCatalogRows(await fetchKieModels(apiKey, fetchImpl));
    const plan = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('kie-price-sync'))`;
      const stored = z.array(storedKieChannelSchema).parse(await tx`
        SELECT id, model_id, task, status, pricing_type, input_per_mtok, output_per_mtok, cached_per_mtok,
          request_price_usd, billing_policy
        FROM channels WHERE base_url ILIKE 'https://api.kie.ai/%' AND NOT is_byok FOR UPDATE`);
      const result = planKieRepricing(stored, catalog);
      if (dryRun) return result;
      const policies = new Map(stored.map((channel) => [channel.id, channel.billing_policy]));
      for (const update of result.updates) {
        const policy = policies.get(update.id);
        if (update.kind === 'chat') {
          await tx`UPDATE channels SET input_per_mtok = ${update.next.inputPerMTok}, output_per_mtok = ${update.next.outputPerMTok},
              cached_per_mtok = ${update.next.cachedPerMTok},
              billing_policy = ${policy ? tx.json(repricedPolicy(policy, update.next, now) as never) : null}, updated_at = now()
            WHERE id = ${update.id}`;
        } else {
          await tx`UPDATE channels SET request_price_usd = ${update.next.requestPriceUsd}, updated_at = now() WHERE id = ${update.id}`;
        }
      }
      const state = { repriced: result.updates.map(({ id, from, to }) => ({ id, from, to })), review: result.review, missing: result.missing, skipped: catalog.skipped.length };
      await tx`INSERT INTO routing_providers (id, upstream_state, upstream_synced_at, upstream_error)
        VALUES ('kie.ai', ${tx.json(state as never)}, ${now}, NULL)
        ON CONFLICT (id) DO UPDATE SET upstream_state = EXCLUDED.upstream_state,
          upstream_synced_at = EXCLUDED.upstream_synced_at, upstream_error = NULL`;
      return result;
    });
    if (!dryRun) {
      for (const update of plan.updates) log.info('kie_prices.repriced', { id: update.id, from: update.from, to: update.to });
      if (plan.review.length) log.warn('kie_prices.needs_review', { review: plan.review });
      if (plan.missing.length) log.warn('kie_prices.missing_upstream', { channels: plan.missing });
    }
    return plan;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('kie_prices.sync_failed', { error: message });
    if (!dryRun) {
      await sql`INSERT INTO routing_providers (id, upstream_error) VALUES ('kie.ai', ${message.slice(0, 500)})
        ON CONFLICT (id) DO UPDATE SET upstream_error = EXCLUDED.upstream_error`.catch(() => undefined);
    }
    throw error;
  }
}
