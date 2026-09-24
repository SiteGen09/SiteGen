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
