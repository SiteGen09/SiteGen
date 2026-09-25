import type { Sql, TransactionSql } from 'postgres';

import { publicRoutingProviderIdentityFromIdentity } from '@/lib/ai/routing-provider';

type Connection = Sql | TransactionSql;

/**
 * One upstream routing provider as the admin pricing page sees it.
 *
 * A consumer-facing provider (such as "Provider B") is many sources, one per
 * family and modality. Membership comes from `source_routing_provider()` in
 * the database, the same function that enforces a provider-wide multiplier.
 */
export interface ProviderPricing {
  /** Internal identity, such as `kie.ai`. Never shown to consumers. */
  id: string;
  /** The stable public id, such as `provider-b`. */
  publicId: string;
  /** Built-in public label, used when no display name is set. */
  defaultLabel: string;
  /** Administrator display name, or null for the built-in label. */
  label: string | null;
  /** Provider-wide multiplier every source is held to, or null when unmanaged. */
  managedMultiplier: string | null;
  /** Whether Auto routing starts with this provider. */
  isDefault: boolean;
  sourceIds: string[];
  /** Channels with a public model id: what the catalog lists as models. */
  modelCount: number;
  minMultiplier: string | null;
  maxMultiplier: string | null;
  /** Digest of every member source and its multiplier, for stale-form checks. */
  fingerprint: string;
}

interface ProviderPricingRow {
  id: string;
  label: string | null;
  managed_multiplier: string | null;
  is_default: boolean;
  source_ids: string[];
  model_count: number;
  min_multiplier: string | null;
  max_multiplier: string | null;
  fingerprint: string;
}

export async function listProviderPricing(db: Connection, id?: string): Promise<ProviderPricing[]> {
  const rows = await db<ProviderPricingRow[]>`
    WITH members AS (
      SELECT s.id, s.credit_multiplier, public.source_routing_provider(s.id, s.label) AS provider_id
      FROM sources s
    ), grouped AS (
      SELECT provider_id,
        array_agg(id ORDER BY id) AS source_ids,
        min(credit_multiplier)::text AS min_multiplier,
        max(credit_multiplier)::text AS max_multiplier,
        md5(string_agg(id || ':' || credit_multiplier::text, ',' ORDER BY id)) AS fingerprint
      FROM members
      WHERE provider_id IS NOT NULL
      GROUP BY provider_id
    )
    SELECT coalesce(g.provider_id, p.id) AS id,
      p.label,
      p.credit_multiplier::text AS managed_multiplier,
      coalesce(p.is_default, false) AS is_default,
      coalesce(g.source_ids, '{}') AS source_ids,
      (SELECT count(*)::int FROM channels c
        WHERE c.source_id = ANY(coalesce(g.source_ids, '{}'))
          AND c.public_model_id IS NOT NULL AND NOT c.is_byok) AS model_count,
      g.min_multiplier,
      g.max_multiplier,
      coalesce(g.fingerprint, md5('')) AS fingerprint
    FROM grouped g
    FULL JOIN routing_providers p ON p.id = g.provider_id
    WHERE ${id ?? null}::text IS NULL OR coalesce(g.provider_id, p.id) = ${id ?? null}::text
    ORDER BY 1`;
  return rows.map((row) => {
    const alias = publicRoutingProviderIdentityFromIdentity({ id: row.id, label: row.id });
    return {
      id: row.id,
      publicId: alias.id,
      defaultLabel: alias.label,
      label: row.label,
      managedMultiplier: row.managed_multiplier,
      isDefault: row.is_default,
      sourceIds: row.source_ids,
      modelCount: row.model_count,
      minMultiplier: row.min_multiplier,
      maxMultiplier: row.max_multiplier,
      fingerprint: row.fingerprint,
    };
  });
}

/** The multiplier every source already shares, or null when they differ. */
export function uniformMultiplier(provider: Pick<ProviderPricing, 'minMultiplier' | 'maxMultiplier'>): number | null {
  const { minMultiplier, maxMultiplier } = provider;
  return minMultiplier !== null && Number(minMultiplier) === Number(maxMultiplier)
    ? Number(minMultiplier)
    : null;
}

/**
 * Whether saving `multiplier` changes any price. Re-entering the price a
 * provider already has is a no-op, so a rename never demands a reprice
 * confirmation. Shared by the form and the server action.
 */
export function isProviderReprice(
  provider: Pick<ProviderPricing, 'managedMultiplier' | 'minMultiplier' | 'maxMultiplier'>,
  multiplier: number | null,
): boolean {
  if (multiplier === null) return false;
  if (provider.managedMultiplier !== null) return multiplier !== Number(provider.managedMultiplier);
  return multiplier !== uniformMultiplier(provider);
}
