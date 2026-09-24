'use client';

import { WhopCheckoutEmbed } from '@whop/checkout/react';
import { useActionState, useState } from 'react';
import { BILLING_TERMS_VERSION, formatUsd, MAX_TOPUP_CENTS, MIN_TOPUP_CENTS, parseUsdCents, TOPUP_PRESETS, topupQuote } from '@/lib/billing/catalog';
import { startCheckout, type CheckoutActionState } from './actions';
import { CheckoutPoller } from './checkout-poller';
import { CheckoutModal } from './checkout-modal';

const INITIAL_STATE: CheckoutActionState = { status: 'idle' };

export function PurchaseForm({ plan, enabled = true }: { plan?: string; enabled?: boolean }) {
  const [attempt, setAttempt] = useState(0);
  return <CheckoutForm key={attempt} plan={plan} enabled={enabled} onClose={() => setAttempt((value) => value + 1)} />;
}

function CheckoutForm({ plan, enabled, onClose }: { plan?: string; enabled: boolean; onClose: () => void }) {
  const [paymentError, setPaymentError] = useState(false);
  const [state, action, pending] = useActionState(startCheckout, INITIAL_STATE);
  const [completed, setCompleted] = useState(false);
  const [amount, setAmount] = useState('10');
  let quote: ReturnType<typeof topupQuote> | null = null;
  try { quote = topupQuote(parseUsdCents(amount)); } catch { /* Input may be incomplete. */ }
  if (state.status === 'ready') {
    const title = plan ? plan.slice(0, 1).toUpperCase() + plan.slice(1) + ' plan checkout with Whop' : 'Checkout with Whop';
    return <CheckoutModal title={title} onClose={onClose}>
      <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
        <WhopCheckoutEmbed
          planId={state.planId}
          sessionId={state.sessionId}
          returnUrl={state.returnUrl}
          skipRedirect
          theme="light"
          onComplete={() => setCompleted(true)}
          onPaymentError={() => setPaymentError(true)}
        />
      </div>
      {paymentError && <p role="alert" className="mt-4 text-sm text-red-400">Payment could not be completed. Check the details in Whop checkout before retrying.</p>}
      {completed && <CheckoutPoller purchaseId={state.purchaseId} />}
    </CheckoutModal>;
  }
  return <form action={action} className="mt-4 space-y-4">
    <input type="hidden" name="kind" value={plan ? 'subscription' : 'topup'} />
    {plan ? <input type="hidden" name="plan" value={plan} /> : <>
      <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <legend className="mb-2 text-sm font-medium">Credit packs</legend>
        {TOPUP_PRESETS.map((cents) => {
          const pack = topupQuote(cents);
          return <label key={cents} className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-300 p-3 text-sm has-checked:border-zinc-900 has-checked:bg-zinc-50">
            <input type="radio" name="pack" checked={amount === String(cents / 100)} onChange={() => setAmount(String(cents / 100))} className="mt-1" />
            <span><strong className="block">{formatUsd(cents)}</strong><span className="block text-xs text-zinc-600">{pack.credits.toLocaleString('en-US')} credits</span>
            </span>
          </label>;
        })}
      </fieldset>
      <div className="max-w-sm">
        <label htmlFor="topup-amount" className="mb-1 block text-sm font-medium">Custom amount (USD)</label>
        <input id="topup-amount" name="amount" type="number" min={MIN_TOPUP_CENTS / 100} max={MAX_TOPUP_CENTS / 100} step="0.01" required value={amount} onChange={(event) => setAmount(event.target.value)} className="w-full rounded-md border border-zinc-300 px-3 py-2" aria-describedby="topup-total" />
        <p className="mt-1 text-xs text-zinc-500">$1.00 minimum, $2,500.00 maximum.</p>
      </div>
      <div id="topup-total" aria-live="polite" className="text-sm">
        <p>{quote ? <><strong>{quote.credits.toLocaleString('en-US')} credits</strong> for a {formatUsd(quote.cents)} USD subtotal.</> : 'Enter an amount from $1.00 to $2,500.00.'}</p>
        {quote && <p className="mt-1 text-xs text-zinc-500">Whop calculates and adds applicable tax based on the buyer&apos;s location.</p>}
      </div>
    </>}
    <label className="flex items-start gap-2 text-xs leading-5 text-zinc-600">
      <input type="checkbox" name="terms" value={BILLING_TERMS_VERSION} required className="mt-1" />
      <span>I agree to the <a href="/billing-terms" target="_blank" rel="noreferrer" className="underline">billing terms</a>{plan ? ' and automatic renewal every 30 days until canceled.' : '. This is a one-time purchase.'}</span>
    </label>
    {state.status === 'error' && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
    <button type="submit" disabled={!enabled || pending || (!plan && !quote)} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50">
      {pending ? 'Opening checkout...' : !enabled ? 'Currently unavailable' : plan ? 'Subscribe with Whop' : 'Buy credits with Whop'}
    </button>
  </form>;
}
