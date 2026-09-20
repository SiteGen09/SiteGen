import { z } from 'zod';

import { authenticateApiKey, requireScope } from '@/lib/api/api-key-auth';
import { openAiErrorFrom } from '@/lib/api/openai-errors';
import { loadRoutingPreferences } from '@/lib/ai/sources';
import { listPublicModels } from '@/lib/ai/channels';
import { isPlanKey, type PlanKey } from '@/lib/billing/plans';
import { logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

const SCOPE = 'chat' as const;

async function loadPlanKey(userId: string): Promise<PlanKey> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('entitlements')
    .select('plan_key')
    .eq('user_id', userId)
    .maybeSingle();

  if (error !== null) {
    return 'free';
  }
  const parsed = z.object({ plan_key: z.string() }).nullable().parse(data);
  return parsed !== null && isPlanKey(parsed.plan_key) ? parsed.plan_key : 'free';
}

/**
 * Lists models the authenticated caller may use on this gateway.
 *
 * OpenAI-compatible shape: each model has an `id` (the public name), `object:
 * "model"`, and an `owned_by` string. The `created` field is a stub — we do
 * not track when each channel was added.
 */
export async function GET(req: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const log = logger({ request_id: requestId, route: 'v1.models' });

  try {
    const auth = await authenticateApiKey(req.headers.get('authorization'), log);
    requireScope(auth, SCOPE);

    const planKey = await loadPlanKey(auth.ownerId);
    const models = await listPublicModels(planKey, await loadRoutingPreferences(auth.ownerId));

    return Response.json({
      object: 'list',
      data: models.map((id) => ({
        id,
        object: 'model',
        created: 1640995200, // Stub timestamp: 2022-01-01
        owned_by: 'system',
      })),
    });
  } catch (err) {
    log.error('models.error', {
      detail: err instanceof Error ? err.message : String(err),
    });
    return openAiErrorFrom(err, requestId);
  }
}
