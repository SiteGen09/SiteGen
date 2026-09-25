import { z } from 'zod';

import { createServiceClient } from '@/lib/supabase/service';

import { FAMILIES, MODALITIES, PROVIDER_PREFERENCE_KEY, routingKey } from './source-types';
export {
  FAMILIES,
  MODALITIES,
  MODALITY_LABELS,
  PROVIDER_PREFERENCE_KEY,
  routingKey,
  taskForModality,
  type Family,
  type Modality,
  type RoutingPreferences,
} from './source-types';

/** Shared parser: PostgREST may serialize numeric as either string or number. */
export const sourceSchema = z.object({
  id: z.string(),
  family: z.enum(FAMILIES),
  label: z.string(),
  description: z.string(),
  credit_multiplier: z.union([z.string(), z.number()]).transform(String),
  modality: z.enum(MODALITIES),
  status: z.enum(['active', 'degraded', 'off']),
  min_plan: z.enum(['free', 'starter', 'pro', 'max']),
  is_default: z.boolean(),
});
export type Source = z.infer<typeof sourceSchema>;
export const SOURCE_COLUMNS =
  'id, family, label, description, credit_multiplier, modality, status, min_plan, is_default';

/**
 * Owner filtering is explicit because the runtime service client bypasses RLS.
 *
 * Keyed by `family:modality`, not family: the same vendor can serve chat,
 * images and video, and those are independent choices.
 */
export async function loadRoutingPreferences(userId: string): Promise<Map<string, string>> {
  const service = createServiceClient();
  const [{ data, error }, provider] = await Promise.all([
    service.from('user_routing_preferences').select('family, modality, source_id').eq('user_id', userId),
    service.from('user_routing_provider').select('provider_id').eq('user_id', userId).maybeSingle(),
  ]);
  if (error) throw new Error(`routing preferences lookup failed: ${error.message}`);
  // Before the migration that creates the table, nobody has a default provider.
  if (provider.error && !['42P01', 'PGRST205'].includes(provider.error.code))
    throw new Error(`routing provider lookup failed: ${provider.error.message}`);
  const providerId = z.object({ provider_id: z.string() }).nullish().parse(provider.data)?.provider_id;
  const rows = z
    .array(
      z.object({
        family: z.enum(FAMILIES),
        modality: z.enum(MODALITIES),
        source_id: z.string(),
      }),
    )
    .parse(data ?? []);
  const preferences = new Map(rows.map((row) => [routingKey(row.family, row.modality), row.source_id]));
  if (providerId) preferences.set(PROVIDER_PREFERENCE_KEY, providerId);
  return preferences;
}

export async function listSources(): Promise<Source[]> {
  const { data, error } = await createServiceClient()
    .from('sources')
    .select(SOURCE_COLUMNS)
    .order('family')
    .order('modality')
    .order('label');
  if (error) throw new Error(`sources lookup failed: ${error.message}`);
  return sourceSchema.array().parse(data ?? []);
}
