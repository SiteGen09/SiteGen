import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { BILLING_TERMS_VERSION, parseUsdCents, topupQuote } from './catalog';
import { getPlans, planKeyFromWhopPlanId } from './plans';
import { whopFetch, type CheckoutSession } from './whop';
import { createWhopClient } from './whop-client';

export function checkoutConfigured(): boolean {
  return Boolean(process.env.WHOP_API_KEY && process.env.WHOP_ACCOUNT_ID && process.env.WHOP_WEBHOOK_SECRET);
}

function signature(userId: string, cents: number, terms: string = BILLING_TERMS_VERSION): string {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  if (!secret) throw new Error('Billing is temporarily unavailable.');
  return createHmac('sha256', secret)
    .update(JSON.stringify(['sitegen-topup-v1', userId, cents, terms]))
    .digest('hex');
}

export function topupMetadata(userId: string, cents: number) {
  const quote = topupQuote(cents);
  return {
    type: 'credit_topup', user_id: userId, credits: String(quote.credits), amount_usd: (cents / 100).toFixed(2),
    userId, creditsToAdd: String(quote.credits), cents: String(cents),
    terms: BILLING_TERMS_VERSION, proof: signature(userId, cents),
  };
}

function signedTopup(metadata: Record<string, unknown>) {
  const parsed = z.object({
    userId: z.uuid(),
    cents: z.string().regex(/^\d+$/),
    proof: z.string().regex(/^[a-f0-9]{64}$/),
    terms: z.literal(BILLING_TERMS_VERSION),
  }).parse(metadata);
  const current = topupQuote(Number(parsed.cents));
  if (metadata.creditsToAdd !== undefined && String(metadata.creditsToAdd) !== String(current.credits)) {
    throw new Error('Credit quantity does not match the server quote');
  }
  if (metadata.type !== 'credit_topup' || metadata.user_id !== parsed.userId ||
      metadata.credits !== String(current.credits) ||
      metadata.amount_usd !== (current.cents / 100).toFixed(2) ||
      metadata.creditsToAdd !== String(current.credits)) {
    throw new Error('Purchase metadata does not match the server quote');
  }
  const expected = signature(parsed.userId, current.cents, parsed.terms);
  if (!timingSafeEqual(Buffer.from(parsed.proof), Buffer.from(expected))) throw new Error('Invalid purchase attribution');
  return { ...current, userId: parsed.userId };
}

export function checkoutResult(value: unknown): CheckoutSession {
  const parsed = z.object({ id: z.string().startsWith('ch_'), purchase_url: z.url(), plan: z.object({ id: z.string().startsWith('plan_') }).nullish() }).parse(value);
  const url = new URL(parsed.purchase_url);
  if (url.protocol !== 'https:' || url.hostname !== 'whop.com' || url.username || url.password) {
    throw new Error('Unexpected checkout destination');
  }
  return { url: parsed.purchase_url, sessionId: parsed.id, carriesUserId: true, planId: parsed.plan?.id };
}

export async function createTopupCheckout(input: { userId: string; cents: number; returnUrl: string; purchaseId: string }): Promise<CheckoutSession> {
  if (!checkoutConfigured() || !process.env.WHOP_PRODUCT_CREDITS) throw new Error('Credit purchases are temporarily unavailable.');
  const quote = topupQuote(input.cents);
  const client = createWhopClient();
  return checkoutResult(await client.checkoutConfigurations.create({
    account_id: process.env.WHOP_ACCOUNT_ID,
    redirect_url: input.returnUrl,
    metadata: { ...topupMetadata(input.userId, quote.cents), purchaseId: input.purchaseId },
    plan: {
      product_id: process.env.WHOP_PRODUCT_CREDITS,
      currency: 'usd',
      plan_type: 'one_time',
      initial_price: quote.cents / 100,
      // Keep the entered amount as Site Gen's subtotal. Whop calculates and
      // adds any applicable buyer-location tax during checkout.
      override_tax_type: 'exclusive',
      visibility: 'hidden',
      title: `${quote.credits.toLocaleString('en-US')} credits`,
      description: 'Prepaid sitegen AI usage. Not transferable or redeemable for cash. Available until consumed, subject to the service terms. No subscription or lifetime service access.',
    },
  }, { idempotencyKey: input.purchaseId }));
}

const money = z.union([z.number(), z.string(), z.object({ amount: z.string(), currency: z.string() })]);
const receiptSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  account_id: z.string(),
  currency: z.string(),
  subtotal: money,
  total: money,
  refunded_amount: money.nullish(),
  plan_id: z.string().nullish(),
  product_id: z.string().nullish(),
  membership_id: z.string().nullish(),
  checkout_configuration_id: z.string().nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
export type Receipt = z.infer<typeof receiptSchema>;

function centsOf(value: z.infer<typeof money>, currency: string): number {
  if (typeof value === 'object' && value.currency !== currency) throw new Error('Mismatched money currency');
  return parseUsdCents(String(typeof value === 'object' ? value.amount : value));
}

export async function retrieveReceipt(paymentId: string): Promise<Receipt> {
  const receipt = receiptSchema.parse(await whopFetch(`/payments/${encodeURIComponent(paymentId)}`));
  if (receipt.id !== paymentId || receipt.account_id !== process.env.WHOP_ACCOUNT_ID) throw new Error('Payment account mismatch');
  return receipt;
}

export interface PurchaseFulfillment {
  payment_id: string;
  user_id: string;
  credits: number;
  reversed: number;
  kind: 'topup' | 'grant';
  meta: Record<string, string | number | null>;
}

/** Validate before any write. Browser credit counts never determine fulfillment. */
export function preparePurchase(receipt: Receipt): PurchaseFulfillment | null {
  if (receipt.account_id !== process.env.WHOP_ACCOUNT_ID) throw new Error('Payment account mismatch');
  const metadata = receipt.metadata ?? {};
  const planKey = receipt.plan_id ? planKeyFromWhopPlanId(receipt.plan_id) : null;
  const topup = metadata.type === 'credit_topup';
  if (!topup && !planKey) return null;
  if (receipt.currency !== 'usd') throw new Error('Expected USD settlement for sitegen credits');
  const purchase = topup ? signedTopup(metadata) : {
    userId: z.uuid().parse(metadata.userId),
    cents: getPlans()[planKey!].priceCents,
    credits: getPlans()[planKey!].monthlyCredits,
  };
  if (topup && receipt.product_id !== process.env.WHOP_PRODUCT_CREDITS) throw new Error('Credit product mismatch');
  const subtotal = centsOf(receipt.subtotal, 'usd');
  const total = centsOf(receipt.total, 'usd');
  const refunded = receipt.refunded_amount == null ? 0 : centsOf(receipt.refunded_amount, 'usd');
  if (subtotal !== purchase.cents || total < purchase.cents) throw new Error('Payment price mismatch');
  if (!['paid', 'succeeded'].includes(receipt.status)) throw new Error('Payment is not paid yet');
  if (total <= 0) throw new Error('Payment total must be positive');
  const reversed = Math.min(purchase.credits, Math.ceil(purchase.credits * refunded / total));
  return {
    payment_id: receipt.id, user_id: purchase.userId, credits: purchase.credits, reversed, kind: topup ? 'topup' : 'grant',
    meta: { source: 'whop', payment_id: receipt.id, checkout_id: receipt.checkout_configuration_id ?? null,
      membership_id: receipt.membership_id ?? null, plan_id: receipt.plan_id ?? null, product_id: receipt.product_id ?? null, total_cents: total,
      plan_key: planKey, amount_cents: purchase.cents, terms: typeof metadata.terms === 'string' ? metadata.terms : null,
      purchase_id: typeof metadata.purchaseId === 'string' ? metadata.purchaseId : null,
      fulfillment: metadata.terms === BILLING_TERMS_VERSION && topup ? 'payment_succeeded_only' : null },
  };
}

/**
 * Used by dispute repair. A paid receipt alone is not sufficient to mint
 * credits: the original payment.succeeded delivery must already be recorded
 * as handled in payments_log. Normal webhooks use fulfill_whop_event, which
 * supplies the confirmed event type inside the same transaction.
 */
export async function syncPurchase(service: SupabaseClient, receipt: Receipt) {
  if (!['paid', 'succeeded'].includes(receipt.status)) return { handled: false, detail: 'payment_not_paid' };
  const purchase = preparePurchase(receipt);
  if (!purchase) return { handled: false, detail: 'unrelated_payment' };
  const { data: confirmation, error: confirmationError } = await service
    .from('payments_log')
    .select('id')
    .eq('payment_id', purchase.payment_id)
    .in('event_type', ['payment.succeeded', 'payment_succeeded'])
    .eq('handled', true)
    .limit(1)
    .maybeSingle();
  if (confirmationError) throw new Error('Payment confirmation lookup failed: ' + confirmationError.message);
  if (confirmation === null) return { handled: false, detail: 'payment_succeeded_not_recorded' };
  const { data, error } = await service.rpc('sync_whop_purchase', {
    p_payment_id: purchase.payment_id, p_user_id: purchase.user_id,
    p_credits: purchase.credits, p_reversed: purchase.reversed, p_kind: purchase.kind,
    p_meta: { ...purchase.meta, confirmed_event_type: 'payment.succeeded' },
  });
  if (error) throw new Error(`Purchase accounting failed: ${error.message}`);
  return { handled: true, detail: 'payment_synced', userId: purchase.user_id, grantedCredits: Number(data) };
}
