import { cache } from 'react';
import { z } from 'zod';

import { createServiceClient } from '@/lib/supabase/service';

import type { RoutingProviderNames } from './routing-provider';

const nameRowSchema = z.object({ id: z.string(), label: z.string() });

/**
 * Administrator display names for routing providers, read once per request.
 *
 * `routing_providers` is server-only (no client grant), so this uses the
 * service client. A deploy can reach a database before the migration that
 * creates the table; until then every provider keeps its built-in alias.
 */
export const loadRoutingProviderNames = cache(async (): Promise<RoutingProviderNames> => {
  const { data, error } = await createServiceClient()
    .from('routing_providers')
    .select('id, label')
    .not('label', 'is', null);
  if (error && ['42P01', 'PGRST205'].includes(error.code)) return new Map();
  if (error) throw new Error(`failed to load routing provider names: ${error.message}`);
  return new Map(z.array(nameRowSchema).parse(data).map((row) => [row.id, row.label]));
});

/**
 * The internal id (such as `relay.fast`) of the provider Auto routing starts
 * with, or null to rely on each source's own Default flag. Before the
 * migration that adds the column, there is no provider-wide default.
 */
export const loadDefaultRoutingProvider = cache(async (): Promise<string | null> => {
  const { data, error } = await createServiceClient()
    .from('routing_providers')
    .select('id')
    .eq('is_default', true)
    .limit(1);
  if (error && ['42P01', '42703', 'PGRST205', 'PGRST204'].includes(error.code)) return null;
  if (error) throw new Error(`failed to load the default routing provider: ${error.message}`);
  return z.array(z.object({ id: z.string() })).parse(data)[0]?.id ?? null;
});
