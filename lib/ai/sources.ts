import { z } from 'zod';

import { createServiceClient } from '@/lib/supabase/service';

import { FAMILIES, type Family } from './source-types';
export { FAMILIES, type Family, type RoutingPreferences } from './source-types';

/** Shared parser: PostgREST may serialize numeric as either string or number. */
export const sourceSchema = z.object({
  id: z.string(),
  family: z.enum(FAMILIES),
  label: z.string(),
  description: z.string(),
  credit_multiplier: z.union([z.string(), z.number()]).transform(String),
  status: z.enum(['active', 'degraded', 'off']),
  min_plan: z.enum(['free', 'starter', 'pro']),
  is_default: z.boolean(),
});
export type Source = z.infer<typeof sourceSchema>;
export const SOURCE_COLUMNS = 'id, family, label, description, credit_multiplier, status, min_plan, is_default';

/** Owner filtering is explicit because the runtime service client bypasses RLS. */
export async function loadRoutingPreferences(userId: string): Promise<Map<Family, string>> {
  const { data, error } = await createServiceClient().from('user_routing_preferences')
    .select('family, source_id').eq('user_id', userId);
  if (error) throw new Error(`routing preferences lookup failed: ${error.message}`);
  const rows = z.array(z.object({ family: z.enum(FAMILIES), source_id: z.string() })).parse(data ?? []);
  return new Map(rows.map((row) => [row.family, row.source_id]));
}

export async function listSources(): Promise<Source[]> {
  const { data, error } = await createServiceClient().from('sources')
    .select(SOURCE_COLUMNS).order('family').order('label');
  if (error) throw new Error(`sources lookup failed: ${error.message}`);
  return sourceSchema.array().parse(data ?? []);
}
