import { z } from 'zod';

import type { ChannelRow } from '@/lib/ai/fallback';
import type { TaskAlias } from '@/lib/ai/provider';
import { planMeetsMinimum } from '@/lib/billing/plans';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Raw channel row as PostgREST returns it. `credit_multiplier` is a
 * `numeric(10,2)`, which supabase-js surfaces as a JSON string, so it is
 * carried as a string all the way to {@link ChannelRow.creditMultiplier}
 * rather than being parsed through a lossy float.
 */
const channelRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  task: z.string(),
  provider: z.enum(['anthropic', 'openai_compatible']),
  base_url: z.string().nullable(),
  model_id: z.string(),
  credit_multiplier: z.union([z.string(), z.number()]).transform(String),
  status: z.string(),
  min_plan: z.string(),
  fallback_to: z.string().nullable(),
  priority: z.number().int(),
});

type ChannelDbRow = z.infer<typeof channelRowSchema>;

const CHANNEL_COLUMNS =
  'id, label, task, provider, base_url, model_id, credit_multiplier, status, min_plan, fallback_to, priority';

/** Higher status is preferred when priority ties. `off` never reaches ranking. */
const STATUS_RANK: Record<string, number> = { active: 2, degraded: 1 };

function toChannelRow(row: ChannelDbRow): ChannelRow {
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.base_url,
    modelId: row.model_id,
    creditMultiplier: row.credit_multiplier,
    status: row.status,
    fallbackTo: row.fallback_to,
  };
}

/**
 * Orders usable channels best-first: highest priority, then `active` over
 * `degraded`. Ties beyond that are broken by id for a stable result.
 */
function bestOf(rows: ChannelDbRow[]): ChannelRow | null {
  const ranked = [...rows].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const statusDelta = (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0);
    if (statusDelta !== 0) return statusDelta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ranked.length > 0 ? toChannelRow(ranked[0]!) : null;
}

/**
 * Picks the platform channel for `task` that `planKey` may use.
 *
 * Considers only channels that are on (`status != 'off'`), meet the plan's
 * minimum, and charge credits (`credit_multiplier > 0`). Zero-multiplier
 * channels are BYOK-only and would bill the platform's own key for free, so
 * they are excluded here and reached through {@link selectByokChannel}.
 */
export async function selectChannel(
  task: TaskAlias,
  planKey: string,
): Promise<ChannelRow | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('task', task)
    .neq('status', 'off')
    .gt('credit_multiplier', 0);

  if (error !== null) {
    throw new Error(`channel lookup failed: ${error.message}`);
  }

  const eligible = channelRowSchema
    .array()
    .parse(data ?? [])
    .filter((row) => planMeetsMinimum(planKey, row.min_plan));

  return bestOf(eligible);
}

/**
 * Picks the BYOK channel for `task` on `provider` that `planKey` may use.
 *
 * BYOK channels carry `credit_multiplier = 0`: the caller's own key pays the
 * provider, so no credits are held or charged. Provider must match the user's
 * stored credential so the decrypted key targets the right API.
 */
export async function selectByokChannel(
  task: TaskAlias,
  provider: 'anthropic' | 'openai_compatible',
  planKey: string,
): Promise<ChannelRow | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('task', task)
    .eq('provider', provider)
    .neq('status', 'off')
    .eq('credit_multiplier', 0);

  if (error !== null) {
    throw new Error(`byok channel lookup failed: ${error.message}`);
  }

  const eligible = channelRowSchema
    .array()
    .parse(data ?? [])
    .filter((row) => planMeetsMinimum(planKey, row.min_plan));

  return bestOf(eligible);
}

/**
 * Resolves a channel by id for the fallback walker. Returns `null` for a
 * missing or fully off channel so the walk stops rather than attempting it.
 */
export async function resolveChannel(id: string): Promise<ChannelRow | null> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('id', id)
    .neq('status', 'off')
    .maybeSingle();

  if (error !== null) {
    throw new Error(`channel resolve failed: ${error.message}`);
  }
  if (data === null) return null;

  return toChannelRow(channelRowSchema.parse(data));
}
