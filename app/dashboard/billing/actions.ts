'use server';

import { assertBillingAccess } from '@/lib/billing/access';
import { randomUUID } from 'node:crypto';
import { requireUser } from '@/lib/dashboard/session';
import { getEntitlement } from '@/lib/dashboard/queries';
import { getPlans, isPlanKey } from '@/lib/billing/plans';
import { parseUsdCents, BILLING_TERMS_VERSION } from '@/lib/billing/catalog';
import { createTopupCheckout } from '@/lib/billing/purchases';
import { createCheckoutSession } from '@/lib/billing/whop';
import { logger } from '@/lib/log';

export type CheckoutActionState =
  | { status: 'idle' }
  | { status: 'error'; error: string }
  | { status: 'ready'; sessionId: string; planId: string; purchaseId: string; returnUrl: string };

export async function startCheckout(
  _state: CheckoutActionState,
  form: FormData,
): Promise<CheckoutActionState> {
  const user = await requireUser();
  if (form.get('terms') !== BILLING_TERMS_VERSION) return { status: 'error', error: 'Accept the billing terms to continue.' };
  let sessionId: string | undefined;
  try {
    await assertBillingAccess(user.id);
    const purchaseId = randomUUID();
    const origin = process.env.NEXT_PUBLIC_APP_URL;
    if (!origin) throw new Error('App URL missing');
    const isTopup = form.get('kind') === 'topup';
    const returnUrl = new URL(isTopup ? '/credits/thanks' : '/dashboard/billing', origin);
    returnUrl.searchParams.set('purchase', purchaseId);
    const common = { userId: user.id, purchaseId, returnUrl: returnUrl.toString() };
    let planId: string | undefined;
    if (isTopup) {
      const cents = parseUsdCents(form.get('amount'));
      const checkout = await createTopupCheckout({ ...common, cents });
      sessionId = checkout.sessionId ?? undefined;
      planId = checkout.planId ?? undefined;
    } else {
      const key = form.get('plan');
      if (typeof key !== 'string' || !isPlanKey(key) || key === 'free') return { status: 'error', error: 'Choose a paid plan.' };
      const entitlement = await getEntitlement(user.id);
      if (entitlement.status === 'active' || entitlement.status === 'past_due') {
        return { status: 'error', error: 'Manage your existing subscription on Whop before starting another plan.' };
      }
      planId = getPlans()[key].whopPlanId ?? undefined;
      if (!planId) throw new Error('Plan not configured');
      sessionId = (await createCheckoutSession({ ...common, planId })).sessionId ?? undefined;
    }
    if (!sessionId || !planId) throw new Error('Incomplete checkout configuration');
    return { status: 'ready', sessionId, planId, purchaseId, returnUrl: returnUrl.toString() };
  } catch (error) {
    logger({ component: 'billing.checkout' }).error('checkout.failed', { detail: error instanceof Error ? error.message : 'Unknown error' });
    return { status: 'error', error: 'Checkout is unavailable. Please check your amount or try again later. No payment was taken here.' };
  }
}
