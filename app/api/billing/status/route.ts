/**
 * Billing status for the signed-in user. Polled by the billing page after a
 * checkout redirect: the redirect itself grants nothing, so the page waits here
 * until the webhook has moved the entitlement.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { apiError } from '@/lib/api/errors';
import { logger } from '@/lib/log';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

const entitlementSchema = z.object({
  plan_key: z.string(),
  status: z.string(),
  current_period_end: z.string().nullable(),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, component: 'billing.status' });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user === null) {
    return apiError('unauthorized', 'Sign in required', requestId, 401);
  }

  const service = createServiceClient();
  const [entitlement, balance] = await Promise.all([
    service
      .from('entitlements')
      .select('plan_key, status, current_period_end')
      .eq('user_id', user.id)
      .maybeSingle(),
    service.rpc('get_balance', { p_user_id: user.id }),
  ]);

  if (entitlement.error !== null || balance.error !== null) {
    log.error('billing.status.read_failed', {
      user_id: user.id,
      detail: entitlement.error?.message ?? balance.error?.message,
    });
    return apiError('internal_error', 'Could not read billing status', requestId, 500);
  }

  const row =
    entitlement.data === null
      ? { plan_key: 'free', status: 'inactive', current_period_end: null }
      : entitlementSchema.parse(entitlement.data);

  return Response.json({
    plan_key: row.plan_key,
    status: row.status,
    current_period_end: row.current_period_end,
    balance: z.coerce.number().parse(balance.data),
  });
}
