import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseUsdCents, quoteFromCredits, topupQuote } from './catalog';
import { getPlans, planMeetsMinimum } from './plans';
import { checkoutResult, createTopupCheckout, syncPurchase, topupMetadata, type Receipt } from './purchases';
import { createCheckoutSession } from './whop';

const userId = '11111111-1111-4111-8111-111111111111';
const rpc = vi.fn(async () => ({ data: 100000, error: null }));
const confirmation = vi.fn<() => Promise<{ data: { id: string } | null; error: { message: string } | null }>>();
const query = {
  select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
  in: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), maybeSingle: confirmation,
};
const from = vi.fn(() => query);
const service = { rpc, from } as unknown as SupabaseClient;
function receipt(cents = 1000): Receipt {
  return { id: 'pay_1', status: 'paid', account_id: 'biz_test', currency: 'usd',
    subtotal: { amount: (cents / 100).toFixed(2), currency: 'usd' },
    total: { amount: (cents / 100).toFixed(2), currency: 'usd' },
    product_id: 'prod_credits', metadata: topupMetadata(userId, cents) };
}
beforeEach(() => {
  vi.clearAllMocks();
  confirmation.mockResolvedValue({ data: { id: 'evt_confirmed' }, error: null });
  vi.stubEnv('WHOP_API_KEY', 'test_key');
  vi.stubEnv('WHOP_ACCOUNT_ID', 'biz_test');
  vi.stubEnv('WHOP_WEBHOOK_SECRET', 'test_secret');
  vi.stubEnv('WHOP_PRODUCT_CREDITS', 'prod_credits');
  vi.stubEnv('WHOP_PLAN_STARTER', 'plan_starter');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('credit catalog', () => {
  it.each([[100, 10000], [500, 50000], [1000, 100000], [5000, 500000], [125000, 12500000], [250000, 25000000], [501, 50100]])('%i cents buys %i credits', (cents, credits) => {
    expect(topupQuote(cents).credits).toBe(credits);
  });
  it.each([99, 0, -1, 250001, NaN, Infinity, 500.1])('rejects invalid amount %s', (value) => expect(() => topupQuote(value)).toThrow());
  it.each([[1, 100], [10000, 100], [10001, 101], [12500000, 125000]])('quotes credit input %i as %i cents', (credits, cents) => {
    expect(quoteFromCredits(credits).cents).toBe(cents);
  });
  it.each(['5.001', '5e2', '-5', '', 'Infinity', ' 5', '0x10'])('rejects malformed decimal %s', (value) => expect(() => parseUsdCents(value)).toThrow());
  it('rejects product IDs where subscription plan IDs are required', () => {
    vi.stubEnv('WHOP_PLAN_STARTER', 'prod_credits');
    vi.stubEnv('WHOP_PLAN_PRO', 'plan_pro');
    expect(getPlans().starter.whopPlanId).toBeNull();
    expect(getPlans().pro.whopPlanId).toBe('plan_pro');
  });
  it('keeps cents exact and plans consistent', () => {
    expect(parseUsdCents('14.99')).toBe(1499);
    expect(getPlans().starter.monthlyCredits).toBe(149000);
    expect(getPlans().pro.monthlyCredits).toBe(299000);
    expect(getPlans().max.monthlyCredits).toBe(499000);
    expect(planMeetsMinimum('max', 'pro')).toBe(true);
    expect(planMeetsMinimum('pro', 'max')).toBe(false);
  });
});

describe('payment validation', () => {
  it('does not repair a paid receipt without a handled successful-payment event', async () => {
    confirmation.mockResolvedValue({ data: null, error: null });
    expect(await syncPurchase(service, receipt())).toEqual({ handled: false, detail: 'payment_succeeded_not_recorded' });
    expect(from).toHaveBeenCalledWith('payments_log');
    expect(query.eq).toHaveBeenCalledWith('payment_id', 'pay_1');
    expect(query.eq).toHaveBeenCalledWith('handled', true);
    expect(query.in).toHaveBeenCalledWith('event_type', ['payment.succeeded', 'payment_succeeded']);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('fails closed when the confirmation lookup fails', async () => {
    confirmation.mockResolvedValue({ data: null, error: { message: 'unavailable' } });
    await expect(syncPurchase(service, receipt())).rejects.toThrow('confirmation lookup failed');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('passes confirmation to accounting only after the successful event is found', async () => {
    expect(await syncPurchase(service, receipt())).toMatchObject({ handled: true });
    expect(rpc).toHaveBeenCalledWith('sync_whop_purchase', expect.objectContaining({
      p_meta: expect.objectContaining({ confirmed_event_type: 'payment.succeeded' }),
    }));
  });
  it('uses the exact credit rate and proportionally reverses a refund', async () => {
    await syncPurchase(service, { ...receipt(50000), refunded_amount: { amount: '250.00', currency: 'usd' } });
    expect(rpc).toHaveBeenCalledWith('sync_whop_purchase', expect.objectContaining({ p_credits: 5000000, p_reversed: 2500000, p_user_id: userId }));
  });
  it('fully reverses a refunded receipt after payment confirmation', async () => {
    await syncPurchase(service, { ...receipt(), refunded_amount: { amount: '10.00', currency: 'usd' } });
    expect(rpc).toHaveBeenCalledWith('sync_whop_purchase', expect.objectContaining({ p_credits: 100000, p_reversed: 100000 }));
  });
  it.each([
    { currency: 'eur' }, { subtotal: 5 }, { total: 5 }, { product_id: 'prod_other' },
  ])('does not grant for mismatched payment %j', async (patch) => {
    await expect(syncPurchase(service, { ...receipt(), ...patch })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects a forged user ID', async () => {
    const paid = receipt();
    paid.metadata!.userId = '22222222-2222-4222-8222-222222222222';
    await expect(syncPurchase(service, paid)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(['cents', 'credits', 'creditsToAdd', 'amount_usd'])('rejects tampered %s metadata', async (field) => {
    const paid = receipt();
    paid.metadata![field] = '50000';
    await expect(syncPurchase(service, paid)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('does not recognize a top-up by the retired kind field alone', async () => {
    const paid = receipt();
    delete paid.metadata!.type;
    paid.metadata!.kind = 'sitegen-topup-v1';
    expect(await syncPurchase(service, paid)).toMatchObject({ handled: false });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('does not grant pending payments', async () => {
    expect(await syncPurchase(service, { ...receipt(), status: 'pending' })).toMatchObject({ handled: false });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('ignores unrelated products', async () => {
    expect(await syncPurchase(service, { ...receipt(), metadata: {} })).toMatchObject({ handled: false });
  });
});

describe('hosted checkout', () => {
  it('sends a server-priced inline one-time plan and signed attribution', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'ch_test', plan: { id: 'plan_dynamic' }, purchase_url: 'https://whop.com/checkout/plan_dynamic/' }));
    vi.stubGlobal('fetch', fetcher);
    const checkout = await createTopupCheckout({ userId, cents: 125000, returnUrl: 'https://gensite.tech/credits/thanks?purchase=purchase_test', purchaseId: 'purchase_test' });
    const options = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(options.body));
    expect(body.plan).toMatchObject({
      initial_price: 1250, currency: 'usd', plan_type: 'one_time', product_id: 'prod_credits',
      override_tax_type: 'exclusive',
    });
    expect(body).toMatchObject({ account_id: 'biz_test', redirect_url: 'https://gensite.tech/credits/thanks?purchase=purchase_test' });
    expect(body.metadata).toMatchObject({ type: 'credit_topup', user_id: userId, credits: '12500000', amount_usd: '1250.00' });
    expect(checkout).toMatchObject({ sessionId: 'ch_test', planId: 'plan_dynamic' });
  });
  it('fails closed without an API key', async () => {
    vi.stubEnv('WHOP_API_KEY', '');
    await expect(createTopupCheckout({ userId, cents: 1000, returnUrl: 'https://sitegen.test', purchaseId: 'purchase_test' })).rejects.toThrow();
  });
  it.each(['http://whop.com/a', 'https://whop.com.evil.test/a', 'https://evil.test/a'])('rejects checkout destination %s', (url) => {
    expect(() => checkoutResult({ id: 'ch_test', purchase_url: url })).toThrow();
  });
  it('creates a monthly Whop checkout for the configured plan and signed-in user', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'ch_subscription', plan: { id: 'plan_starter' }, purchase_url: 'https://whop.com/checkout/plan_starter/' }));
    vi.stubGlobal('fetch', fetcher);
    const checkout = await createCheckoutSession({ planId: 'plan_starter', userId, returnUrl: 'https://sitegen.test/dashboard/billing?purchase=purchase_test', purchaseId: 'purchase_test' });
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(request.body));
    expect(new URL(url).pathname).toBe('/api/v1/checkout_configurations');
    expect(request.method).toBe('POST');
    expect(body).toMatchObject({ account_id: 'biz_test', plan_id: 'plan_starter', redirect_url: 'https://sitegen.test/dashboard/billing?purchase=purchase_test' });
    expect(body.metadata).toMatchObject({ userId, purchaseId: 'purchase_test' });
    expect(checkout).toMatchObject({ sessionId: 'ch_subscription', planId: 'plan_starter', carriesUserId: true });
  });
  it('rejects a plan id that is not in the server plan catalog', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(createCheckoutSession({ planId: 'prod_wrong', userId, returnUrl: 'https://sitegen.test', purchaseId: 'purchase_test' })).rejects.toThrow('Unknown subscription plan');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
