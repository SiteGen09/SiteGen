import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { parseUsdCents } from './catalog';
import { disputeSchema } from './disputes';
import { getPlans, planKeyFromWhopPlanId } from './plans';
import { preparePurchase, retrieveReceipt, type PurchaseFulfillment } from './purchases';
import { classifyEvent, fetchMembership, resolveUser, whopFetch, type WhopEvent, type WhopMembership } from './whop';
import type { Logger } from '@/lib/log';

export interface MembershipFulfillment {
  user_id: string;
  plan_key: 'starter' | 'pro' | 'max';
  status: 'active' | 'past_due' | 'inactive';
  external_id: string;
  current_period_end: string | null;
  monthly_credits: number;
  observed_at: string;
}

export interface DisputeFulfillment {
  id: string;
  payment_id: string;
  status: string;
  amount_cents: number;
  currency: string;
  reason: string | null;
  updated_at: string;
  evidence_due_at: string | null;
}

export interface PreparedEvent {
  purchase: PurchaseFulfillment | null;
  membership: MembershipFulfillment | null;
  dispute: DisputeFulfillment | null;
}

async function prepareMembership(
  service: SupabaseClient, membership: WhopMembership, log: Logger,
): Promise<MembershipFulfillment | null> {
  const key = planKeyFromWhopPlanId(membership.planId);
  if (!key || key === 'free') return null;
  const link = await resolveUser(service, { metadata: membership.metadata, membershipId: membership.id, email: membership.email }, log);
  if (!link) {
    log.error('whop.membership.unmapped', { membership_id: membership.id, alert: true });
    return null;
  }
  const status = ['active', 'trialing', 'canceling', 'completed'].includes(membership.status)
    ? 'active' : membership.status === 'past_due' ? 'past_due' : 'inactive';
  return {
    user_id: link.userId, plan_key: key, status, external_id: membership.id,
    current_period_end: membership.currentPeriodEnd, monthly_credits: getPlans()[key].monthlyCredits,
    observed_at: new Date().toISOString(),
  };
}

const paymentId = z.string().regex(/^pay_[A-Za-z0-9_-]+$/).max(200);
const membershipId = z.string().regex(/^mem_[A-Za-z0-9_-]+$/).max(200);
const refund = z.object({ payment_id: paymentId.nullish(), payment: z.object({ id: paymentId }).nullish() });

/** All provider reads and validation happen before the atomic database write. */
export async function prepareWhopEvent(service: SupabaseClient, event: WhopEvent, log: Logger): Promise<PreparedEvent> {
  const result: PreparedEvent = { purchase: null, membership: null, dispute: null };
  const kind = classifyEvent(event.type);
  if (kind === 'membership_valid' || kind === 'membership_invalid') {
    // Re-read access: Whop deliveries may arrive out of order. Activation never grants credits.
    const membership = await fetchMembership(membershipId.parse(event.data.id));
    if (!membership) throw new Error('Membership is not available yet');
    result.membership = await prepareMembership(service, membership, log);
  } else if (kind === 'payment_failed') {
    const parsed = z.object({ membership_id: membershipId.nullish(), membership: z.object({ id: membershipId }).nullish() }).parse(event.data);
    const id = parsed.membership_id ?? parsed.membership?.id;
    if (id) {
      const membership = await fetchMembership(id);
      if (!membership) throw new Error('Membership is not available yet');
      result.membership = await prepareMembership(service, membership, log);
    }
  } else if (kind === 'payment_succeeded' || event.type === 'refund.created' || event.type === 'refund.updated') {
    const refundData = kind === 'payment_succeeded' ? null : refund.parse(event.data);
    const id = paymentId.parse(kind === 'payment_succeeded' ? event.data.id : refundData?.payment_id ?? refundData?.payment?.id);
    const receipt = await retrieveReceipt(id);
    result.purchase = preparePurchase(receipt);
    if (result.purchase?.kind === 'grant' && receipt.membership_id) {
      const membership = await fetchMembership(receipt.membership_id);
      if (!membership) throw new Error('Membership is not available yet');
      result.membership = await prepareMembership(service, { ...membership, metadata: { ...receipt.metadata, ...membership.metadata } }, log);
    }
  } else if (event.type.startsWith('dispute.')) {
    const id = z.string().regex(/^dspt_[A-Za-z0-9_-]+$/).max(200).parse(event.data.id);
    const dispute = disputeSchema.parse(await whopFetch('/disputes/' + encodeURIComponent(id)));
    if (dispute.id !== id || dispute.account_id !== process.env.WHOP_ACCOUNT_ID) throw new Error('Dispute account mismatch');
    result.purchase = preparePurchase(await retrieveReceipt(dispute.payment.id));
    if (result.purchase) result.dispute = {
      id, payment_id: dispute.payment.id, status: dispute.status, amount_cents: parseUsdCents(String(dispute.amount)),
      currency: dispute.currency, reason: dispute.reason ?? null, updated_at: dispute.updated_at, evidence_due_at: dispute.evidence_due_at ?? null,
    };
  }
  return result;
}

export const fulfillmentResult = z.object({
  duplicate: z.boolean(), handled: z.boolean(), creditsAdded: z.number().int().safe(),
});
