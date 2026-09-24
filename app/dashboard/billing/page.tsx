import Link from 'next/link';
import { billingAccess } from '@/lib/billing/access';
import { RedeemCodeForm } from './redeem-code-form';
import { PLAN_KEYS, getPlans } from '@/lib/billing/plans';
import { checkoutConfigured } from '@/lib/billing/purchases';
import { formatUsd } from '@/lib/billing/catalog';
import { getBalance, getEntitlement } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';
import { Card, PageHeader, Stat, StatusBadge, formatCredits, formatTimestamp } from '../ui';
import { CheckoutPoller } from './checkout-poller';
import { PurchaseForm } from './purchase-form';
import { TopupForm } from './topup-form';

export const metadata = { title: 'Billing - sitegen' };

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ purchase?: string }> }) {
  const [user, params] = await Promise.all([requireUser(), searchParams]);
  const [entitlement, balance] = await Promise.all([getEntitlement(user.id), getBalance()]);
  const plans = getPlans();
  const subscribed = entitlement.status === 'active' || entitlement.status === 'past_due';
  const allowed = await billingAccess(user.id);
  const ready = checkoutConfigured() && allowed;
  return <>
    <PageHeader title="Billing" description="Subscriptions and prepaid AI credits. All prices in USD." />
    <Link href="/dashboard/billing/history" className="mb-6 inline-block text-sm underline">View order and redemption history</Link>
    {!allowed && <p role="alert" className="mb-6 rounded border border-amber-400 p-4 text-sm">Your account is frozen. AI usage and new purchases are disabled. Contact support to review your account. Your billing history remains available.</p>}
    {params.purchase && <CheckoutPoller purchaseId={params.purchase} />}
    <div className="mb-8 grid gap-4 sm:grid-cols-3">
      <Stat label="Plan" value={plans[entitlement.planKey].label} hint={formatCredits(entitlement.monthlyCredits) + ' credits per paid period'} />
      <Card>
        <p className="text-xs text-zinc-500">Subscription</p>
        <div className="mt-2"><StatusBadge status={entitlement.status} /></div>
        <p className="mt-2 text-xs text-zinc-500">{entitlement.currentPeriodEnd ? 'Current period ends ' + formatTimestamp(entitlement.currentPeriodEnd) : 'No paid period'}</p>
        <a href="https://whop.com/@me/settings/orders/" className="mt-3 inline-block text-sm underline">Manage billing and cancellations</a>
      </Card>
      <Stat label="Available credits" value={formatCredits(balance)} hint="$1 USD = 10,000 credits" />
    </div>
    <h2 className="mb-3 text-base font-semibold">Monthly plans</h2>
    <div className="grid gap-4 lg:grid-cols-3">
      {PLAN_KEYS.filter((key) => key !== 'free').map((key) => {
        const plan = plans[key];
        const current = subscribed && key === entitlement.planKey;
        return <Card key={key} className={current ? 'border-zinc-900' : undefined}>
          <div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="font-semibold">{plan.label}</h3>{current && <span className="text-xs text-emerald-700">Current plan</span>}</div>
          <p className="mt-3 text-2xl font-semibold">{formatUsd(plan.priceCents)} <span className="text-sm font-normal text-zinc-500">USD / 30 days</span></p>
          <p className="mt-2 text-sm">{formatCredits(plan.monthlyCredits)} credits per paid period</p>
          <p className="mt-1 text-xs text-zinc-500">{plan.rateLimitRpm} requests / minute</p>
          {subscribed ? <a href="https://whop.com/@me/settings/orders/" className="mt-5 inline-block text-sm underline">Manage subscription on Whop</a> : <PurchaseForm plan={key} enabled={ready && Boolean(plan.whopPlanId)} />}
        </Card>;
      })}
    </div>
    <section className="mt-10 border-t border-zinc-200 pt-6">
      <h2 className="text-base font-semibold">Add credits</h2>
      <p className="mt-1 text-sm text-zinc-600">One-time purchases. Credits are for sitegen usage and cannot be transferred or withdrawn as cash.</p>
      <TopupForm userId={user.id} enabled={ready && Boolean(process.env.WHOP_PRODUCT_CREDITS)} />
    </section>
    <section className="mt-10 border-t border-zinc-200 pt-6"><h2 className="font-semibold">Redeem credits</h2>{allowed ? <RedeemCodeForm /> : <p className="mt-2 text-sm">Redemption is unavailable while your account is frozen.</p>}</section>
    <nav className="mt-8 flex flex-wrap gap-x-4 gap-y-1 text-xs leading-6 text-zinc-500" aria-label="Billing and legal pages">
      <Link className="underline" href="/billing-terms">Billing terms</Link>
      <Link className="underline" href="/refund-policy">Refund policy</Link>
      <Link className="underline" href="/terms">Terms</Link>
      <Link className="underline" href="/privacy">Privacy</Link>
      <Link className="underline" href="/eula">EULA</Link>
      <span>Taxes and buyer fees, if applicable, are shown by Whop before payment.</span>
    </nav>
  </>;
}
