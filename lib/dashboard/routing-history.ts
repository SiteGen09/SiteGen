import { billingPolicySchema } from '@/lib/ai/billing-policy';
import type { Family, Modality } from '@/lib/ai/source-types';
import type { ModelCatalogEntry } from './queries';
import {
  publicRoutingProviderIdentity,
  publicRoutingProviderIdentityFromIdentity,
} from '@/lib/ai/routing-provider';

export interface RoutingPriceHistoryEntry {
  id: string;
  createdAt: string;
  providerLabel: string;
  modelLabel: string | null;
  family: Family | null;
  modality: Modality;
  priceLabel: string;
  unit: 'multiplier' | 'usd_per_mtok' | 'usd_per_job';
  previous: number | null;
  current: number | null;
}

export interface RoutingAudit {
  id: number;
  action: string;
  target: string;
  before: unknown;
  after: unknown;
  created_at: string;
}

function snapshot(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function price(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

type Rate = { label: string; value: number; unit: RoutingPriceHistoryEntry['unit'] };
function rates(value: unknown): Map<string, Rate> {
  const row = snapshot(value);
  const result = new Map<string, Rate>();
  const add = (key: string, label: string, raw: unknown, unit: Rate['unit']) => {
    const value = price(raw);
    if (value !== null) result.set(key, { label, value, unit });
  };
  const parsed = billingPolicySchema.safeParse(row.billing_policy);
  const policy = parsed.success ? parsed.data : null;
  if (row.pricing_type === 'request') {
    if (policy?.imagePrices) {
      add('job:standard', 'Image · up to 1792 px', policy.imagePrices.standard, 'usd_per_job');
      add('job:large', 'Image · larger sizes', policy.imagePrices.large, 'usd_per_job');
    } else add('job:standard', 'Per job', row.request_price_usd, 'usd_per_job');
    return result;
  }
  if (policy) {
    for (const tier of policy.tiers) {
      const prefix = tier.name === 'standard' ? '' : tier.name.replaceAll('_', ' ') + ' · ';
      add(tier.name + ':input', prefix + 'Input', tier.rates.inputPerMTok, 'usd_per_mtok');
      add(tier.name + ':output', prefix + 'Output', tier.rates.outputPerMTok, 'usd_per_mtok');
      add(tier.name + ':cache', prefix + 'Cache read', tier.rates.cachedPerMTok, 'usd_per_mtok');
      add(tier.name + ':write', prefix + 'Cache write', tier.rates.cacheWritePerMTok, 'usd_per_mtok');
    }
  } else {
    add('standard:input', 'Input', row.input_per_mtok, 'usd_per_mtok');
    add('standard:output', 'Output', row.output_per_mtok, 'usd_per_mtok');
    add('standard:cache', 'Cache read', row.cached_per_mtok, 'usd_per_mtok');
  }
  return result;
}

/** Only public pricing is returned; audit snapshots can contain private routing metadata. */
export function routingPriceChanges(row: RoutingAudit, models: readonly ModelCatalogEntry[]): RoutingPriceHistoryEntry[] {
  const sourceChange = row.action === 'source.update';
  if (!sourceChange && row.action !== 'channel.update') return [];
  const id = row.target.replace(sourceChange ? /^source:/ : /^channel:/, '');
  const model = models.find((item) => !item.isByok && (sourceChange ? item.sourceId === id : item.id === id));
  if (!model) return [];
  const identity = model.routingProvider
    ? publicRoutingProviderIdentityFromIdentity(model.routingProvider)
    : publicRoutingProviderIdentity({
        sourceId: model.sourceId, sourceLabel: model.sourceLabel, provider: model.provider,
      });
  const context = {
    createdAt: row.created_at, providerLabel: identity.label,
    modelLabel: sourceChange ? null : model.label, family: model.family, modality: model.modality,
  };
  if (sourceChange) {
    const previous = price(snapshot(row.before).credit_multiplier);
    const current = price(snapshot(row.after).credit_multiplier);
    if (previous === null || current === null || previous === current) return [];
    return [{ ...context, id: row.id + ':multiplier', priceLabel: 'Price multiplier', unit: 'multiplier', previous, current }];
  }
  const before = rates(row.before);
  const after = rates(row.after);
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((key) => {
    const oldRate = before.get(key);
    const newRate = after.get(key);
    const previous = oldRate?.value ?? null;
    const current = newRate?.value ?? null;
    if (previous === current) return [];
    const rate = newRate ?? oldRate!;
    return [{ ...context, id: row.id + ':' + key, priceLabel: rate.label, unit: rate.unit, previous, current }];
  });
}
