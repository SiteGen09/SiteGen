import { redirect } from 'next/navigation';
import { PLAN_KEYS, getPlans, getTopupProduct, type PlanDef } from '@/lib/billing/plans';
import { createCheckoutSession, ourPlanIds } from '@/lib/billing/whop';
import { getBalance, getEntitlement } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';
import { logger } from '@/lib/log';
import { Card, PageHeader, Stat, StatusBadge, formatCredits, formatTimestamp } from '../ui';
import { CheckoutPoller } from './checkout-poller';

/**
 * Billing. Plan ids (WHOP_PLAN_*) are not secrets and are safe to send to the
 * browser; WHOP_API_KEY is, and never leaves this server component — the
 * checkout configuration that carries our user id is created in the server
 * action below, and the browser only ever receives the resulting Whop URL.
 *
 * Nothing on this page grants anything. The redirect back from Whop only sets
 * `?pending=1`; entitlements and credits move exclusively in the webhook
 * (app/api/webhooks/whop/route.ts).
 */

export const metadata = { title: 'Billing — sitegen' };

async function startCheckout(formData: FormData): Promise<void> {
  'use server';

  const user = await requireUser();
  const planId = formData.get('plan_id');
  if (typeof planId !== 'string' || !ourPlanIds().has(planId)) {
    throw new Error('billing: unknown plan id');
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const session = await createCheckoutSession({
    planId,
    userId: user.id,
    returnUrl: `${appUrl}/dashboard/billing?pending=1`,
  });

  logger({ component: 'billing.checkout' }).info('billing.checkout.start', {
    user_id: user.id,
    plan_id: planId,
    attributed: session.carriesUserId,
  });

  redirect(session.url);
}

function CheckoutButton({ planId, label }: { planId: string | null; label: string }) {
  if (planId === null) {
    return (
      <p className="mt-4 text-xs text-zinc-500">
        Not configured. Set the matching WHOP_PLAN_* environment variable.
      </p>
    );
  }
  return (
    <form action={startCheckout} className="mt-4">
      <input type="hidden" name="plan_id" value={planId} />
      <button
        type="submit"
        className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800"
      >
        {label}
      </button>
    </form>
  );
}

function PlanCard({ plan, current }: { plan: PlanDef; current: boolean }) {
  return (
    <Card className={current ? 'border-zinc-900' : undefined}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-zinc-900">{plan.label}</h3>
        {current && (
          <span className="rounded-full bg-zinc-900 px-2 py-0.5 text-xs text-white">Current</span>
        )}
      </div>
      <dl className="mt-3 space-y-1 text-sm text-zinc-600">
        <div className="flex justify-between">
          <dt>Credits / month</dt>
          <dd className="text-zinc-900">{formatCredits(plan.monthlyCredits)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Rate limit</dt>
          <dd className="text-zinc-900">{plan.rateLimitRpm} rpm</dd>
        </div>
      </dl>
      {plan.key !== 'free' && (
        <CheckoutButton planId={plan.whopPlanId} label={current ? 'Manage on Whop' : 'Upgrade'} />
      )}
    </Card>
  );
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ pending?: string }>;
}) {
  const [user, params] = await Promise.all([requireUser(), searchParams]);
  const [entitlement, balance] = await Promise.all([getEntitlement(user.id), getBalance()]);
  const plans = getPlans();
  const topup = getTopupProduct();

  return (
    <>
      <PageHeader
        title="Billing"
        description="Plans and credits are billed through Whop. Credits are granted when Whop confirms the payment, not when you return here."
      />

      {params.pending === '1' && (
        <CheckoutPoller initialPlanKey={entitlement.planKey} initialStatus={entitlement.status} />
      )}

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat
          label="Plan"
          value={plans[entitlement.planKey].label}
          hint={`${formatCredits(entitlement.monthlyCredits)} credits / month`}
        />
        <Card>
          <p className="text-xs uppercase tracking-wide text-zinc-500">Status</p>
          <div className="mt-2 flex items-center gap-2">
            <StatusBadge status={entitlement.status} />
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {entitlement.currentPeriodEnd === null
              ? 'No renewal scheduled'
              : `Renews ${formatTimestamp(entitlement.currentPeriodEnd)}`}
          </p>
        </Card>
        <Stat label="Balance" value={formatCredits(balance)} hint="credits" />
      </div>

      <h2 className="mb-3 text-sm font-semibold text-zinc-900">Plans</h2>
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PLAN_KEYS.map((key) => (
          <PlanCard key={key} plan={plans[key]} current={key === entitlement.planKey} />
        ))}
      </div>

      <h2 className="mb-3 text-sm font-semibold text-zinc-900">Top up</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <h3 className="text-sm font-semibold text-zinc-900">Credit pack</h3>
          <p className="mt-3 text-sm text-zinc-600">
            One-off purchase of {formatCredits(topup.credits)} credits. No subscription, never
            expires.
          </p>
          <CheckoutButton planId={topup.whopPlanId} label="Buy credits" />
        </Card>
      </div>
    </>
  );
}
