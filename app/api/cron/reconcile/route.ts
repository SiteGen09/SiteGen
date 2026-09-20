/**
 * Nightly reconciliation: webhooks are the source of truth, this is the safety
 * net for deliveries that never landed. It pulls the account's active Whop
 * memberships (docs: GET /memberships, cursor paging via `page_info`) and
 * repairs entitlement drift in both directions.
 *
 * It never grants credits: grants are keyed on the membership period end by the
 * webhook handler, so a cron that invented dates would double-grant.
 * Authenticated with CRON_SECRET as a bearer token.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { apiError } from '@/lib/api/errors';
import {
  getPlans,
  isPlanKey,
  planKeyFromWhopPlanId,
  type PlanKey,
} from '@/lib/billing/plans';
import {
  ENTITLED_WHOP_STATUSES,
  fetchMembershipPage,
  ourPlanIds,
  readEntitlement,
  resolveUser,
  type WhopMembership,
} from '@/lib/billing/whop';
import { logger, type Logger } from '@/lib/log';
import { reclaimStrandedHolds } from '@/lib/generate/ledger';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Default age before a hold is treated as abandoned. Long enough that a slow
 * but live request is never reclaimed out from under itself.
 */
const STRANDED_HOLD_AGE = '15 minutes';

/**
 * Releases holds abandoned by a process that died between the hold and its
 * settle. Independent of the Whop pass: a failure here must not lose the
 * entitlement reconciliation, so its error is logged and swallowed.
 */
async function reclaimHolds(log: Logger): Promise<{ count: number; credits: number }> {
  try {
    const result = await reclaimStrandedHolds(STRANDED_HOLD_AGE);
    for (const hold of result.holds) {
      log.warn('reconcile.hold_reclaimed', {
        request_id: hold.requestId,
        user_id: hold.userId,
        credits: hold.credits,
        held_since: hold.heldSince,
      });
    }
    return { count: result.count, credits: result.credits };
  } catch (error) {
    log.error('reconcile.hold_reclaim_failed', {
      alert: true,
      detail: error instanceof Error ? error.message : 'unknown error',
    });
    return { count: 0, credits: 0 };
  }
}

/** Hard stop so a paging bug cannot loop forever. */
const MAX_PAGES = 50;

function authorized(header: string | null, secret: string): boolean {
  if (header === null) return false;
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header, 'utf8'), Buffer.from(expected, 'utf8'));
}

const activeEntitlementSchema = z.object({
  user_id: z.uuid(),
  plan_key: z.string(),
  status: z.string(),
  external_id: z.string().nullable(),
  current_period_end: z.string().nullable(),
  monthly_credits: z.coerce.number(),
});

async function repairFromWhop(
  service: SupabaseClient,
  membership: WhopMembership,
  log: Logger,
): Promise<{ userId: string | null; repaired: boolean }> {
  const planKey = planKeyFromWhopPlanId(membership.planId);
  if (planKey === null) return { userId: null, repaired: false };

  const link = await resolveUser(
    service,
    { metadata: membership.metadata, membershipId: membership.id, email: membership.email },
    log,
  );
  if (link === null) {
    log.error('reconcile.unmapped_membership', {
      alert: true,
      membership_id: membership.id,
      detail: 'active Whop membership with no mappable user',
    });
    return { userId: null, repaired: false };
  }

  const existing = await readEntitlement(service, link.userId);
  const periodEnd = membership.currentPeriodEnd ?? existing?.current_period_end ?? null;
  const expectedCredits = getPlans()[planKey].monthlyCredits;
  const drifted =
    existing === null ||
    existing.plan_key !== planKey ||
    existing.status !== 'active' ||
    existing.current_period_end !== periodEnd ||
    existing.monthly_credits !== expectedCredits ||
    existing.external_id !== membership.id;

  if (!drifted) return { userId: link.userId, repaired: false };

  const { error } = await service.from('entitlements').upsert(
    {
      user_id: link.userId,
      plan_key: planKey,
      status: 'active',
      provider: 'whop',
      external_id: membership.id,
      current_period_end: periodEnd,
      monthly_credits: expectedCredits,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error !== null) throw new Error(`reconcile: entitlement repair failed: ${error.message}`);

  log.warn('reconcile.repaired', {
    user_id: link.userId,
    membership_id: membership.id,
    before: existing === null ? null : { plan_key: existing.plan_key, status: existing.status },
    after: { plan_key: planKey, status: 'active', current_period_end: periodEnd },
  });
  return { userId: link.userId, repaired: true };
}

export async function GET(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, component: 'billing.reconcile' });

  const secret = process.env.CRON_SECRET;
  if (secret === undefined || secret === '') {
    log.error('reconcile.secret_missing', { alert: true });
    return apiError('internal_error', 'CRON_SECRET is not configured', requestId, 500);
  }
  if (!authorized(request.headers.get('authorization'), secret)) {
    log.warn('reconcile.unauthorized');
    return apiError('unauthorized', 'Invalid cron credentials', requestId, 401);
  }
  // Reclaim stranded holds first, so a missing WHOP_API_KEY or a Whop outage
  // — both of which abort the entitlement pass below — can never leave a
  // customer's held credits stranded. This is the whole point of the sweep.
  const holds = await reclaimHolds(log);

  // Surfaced explicitly: without an API key every page read fails, and a
  // generic 500 would hide the actual cause from the cron log.
  const apiKey = process.env.WHOP_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    log.error('reconcile.api_key_missing', { alert: true });
    return apiError('internal_error', 'WHOP_API_KEY is not configured', requestId, 500);
  }

  const service = createServiceClient();
  const knownPlanIds = ourPlanIds();

  let checked = 0;
  let repaired = 0;
  const seenMemberships = new Set<string>();
  const activeUserIds = new Set<string>();

  try {
    for (const status of ENTITLED_WHOP_STATUSES) {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await fetchMembershipPage({ status, after: cursor });
        for (const membership of result.memberships) {
          // The API key is account-scoped; narrow further to the plans we sell.
          if (!knownPlanIds.has(membership.planId)) continue;
          checked += 1;
          seenMemberships.add(membership.id);
          const outcome = await repairFromWhop(service, membership, log);
          if (outcome.userId !== null) activeUserIds.add(outcome.userId);
          if (outcome.repaired) repaired += 1;
        }
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
    }

    // The other direction: active for us, gone or canceled at Whop.
    const { data, error } = await service
      .from('entitlements')
      .select('user_id, plan_key, status, external_id, current_period_end, monthly_credits')
      .eq('provider', 'whop')
      .eq('status', 'active');
    if (error !== null) throw new Error(`reconcile: entitlement scan failed: ${error.message}`);

    for (const row of z.array(activeEntitlementSchema).parse(data ?? [])) {
      const planKey: PlanKey = isPlanKey(row.plan_key) ? row.plan_key : 'free';
      if (planKey === 'free') continue;
      if (row.external_id !== null && seenMemberships.has(row.external_id)) continue;
      if (activeUserIds.has(row.user_id)) continue;

      checked += 1;
      const { error: updateError } = await service
        .from('entitlements')
        .update({ status: 'inactive', updated_at: new Date().toISOString() })
        .eq('user_id', row.user_id);
      if (updateError !== null) {
        throw new Error(`reconcile: deactivation failed: ${updateError.message}`);
      }
      repaired += 1;
      log.warn('reconcile.deactivated', {
        user_id: row.user_id,
        membership_id: row.external_id,
        plan_key: planKey,
        detail: 'entitlement active locally but not active at Whop',
      });
    }
  } catch (error) {
    log.error('reconcile.failed', {
      alert: true,
      checked,
      repaired,
      detail: error instanceof Error ? error.message : 'unknown error',
    });
    return apiError('internal_error', 'Reconciliation failed', requestId, 500);
  }


  log.info('reconcile.completed', {
    checked,
    repaired,
    holds_reclaimed: holds.count,
    credits_reclaimed: holds.credits,
  });
  return Response.json({
    checked,
    repaired,
    holds_reclaimed: holds.count,
    credits_reclaimed: holds.credits,
    request_id: requestId,
  });
}
