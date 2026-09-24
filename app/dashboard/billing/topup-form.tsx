'use client';

import { useState, type FormEvent } from 'react';
import { WhopCheckoutEmbed } from '@whop/checkout/react';
import { z } from 'zod';
import { formatUsd, MAX_TOPUP_CENTS, parseUsdCents, quoteFromCredits, TOPUP_PRESETS, topupQuote } from '@/lib/billing/catalog';
import { CheckoutModal } from './checkout-modal';
import { CheckoutPoller } from './checkout-poller';

const checkoutSchema = z.object({
  checkoutConfigId: z.string().startsWith('ch_'),
  purchaseId: z.uuid(),
  planId: z.string().startsWith('plan_'),
  purchaseUrl: z.url(),
  returnUrl: z.url(),
  amountUsd: z.number(),
  credits: z.number().int().positive(),
});
type Checkout = z.infer<typeof checkoutSchema>;

export function TopupForm({ userId, enabled }: { userId: string; enabled: boolean }) {
  const [unit, setUnit] = useState<'usd' | 'credits'>('usd');
  const [value, setValue] = useState('10');
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  let quote: ReturnType<typeof topupQuote> | null = null;
  try { quote = unit === 'usd' ? topupQuote(parseUsdCents(value)) : quoteFromCredits(value); } catch { /* Allow incomplete input. */ }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !quote || !enabled) return;
    setPending(true);
    setError(null);
    setCompleted(false);
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...(unit === 'usd' ? { amountUsd: value } : { credits: value }) }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
        throw new Error(parsed.success ? parsed.data.error.message : 'Checkout is unavailable. Please try again.');
      }
      const session = checkoutSchema.parse(body);
      const destination = new URL(session.purchaseUrl);
      if (destination.protocol !== 'https:' || destination.hostname !== 'whop.com') throw new Error('Invalid checkout destination');
      setCheckout(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Checkout is unavailable. Please try again.');
    } finally { setPending(false); }
  }

  if (checkout) return <CheckoutModal title="Add credits with Whop" onClose={() => { setCheckout(null); setError(null); setCompleted(false); }}>
    <p className="mb-4 text-sm">{checkout.credits.toLocaleString('en-US')} credits for a {formatUsd(Math.round(checkout.amountUsd * 100))} USD subtotal. Whop adds any applicable tax at checkout.</p>
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
      <WhopCheckoutEmbed planId={checkout.planId} sessionId={checkout.checkoutConfigId} returnUrl={checkout.returnUrl} skipRedirect theme="light"
        onComplete={() => setCompleted(true)}
        onPaymentError={() => setError('Payment could not be completed. Check the details in Whop checkout before retrying.')} />
    </div>
    {error && <p role="alert" className="mt-4 text-sm text-red-400">{error}</p>}
    {completed && <CheckoutPoller purchaseId={checkout.purchaseId} />}
    <a href={checkout.purchaseUrl} target="_blank" rel="noreferrer" className="mt-4 inline-block text-sm underline">Open secure checkout on Whop in a new tab</a>
  </CheckoutModal>;

  return <form onSubmit={submit} className="mt-4 space-y-4">
    <fieldset disabled={pending || !enabled}>
      <legend className="mb-2 text-sm font-medium">Choose an amount</legend>
      <div className="flex flex-wrap gap-2">{TOPUP_PRESETS.map((cents) => <button key={cents} type="button"
        className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-50 disabled:opacity-50"
        onClick={() => { setUnit('usd'); setValue(String(cents / 100)); }}>{formatUsd(cents)}</button>)}</div>
      <div className="mt-4 grid max-w-lg gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">Enter amount in
          <select value={unit} onChange={(event) => { setUnit(event.target.value as 'usd' | 'credits'); setValue(quote ? String(event.target.value === 'usd' ? quote.cents / 100 : quote.credits) : ''); }}
            className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2">
            <option value="usd">US dollars</option><option value="credits">Credits</option>
          </select>
        </label>
        <label className="text-sm font-medium">{unit === 'usd' ? 'Custom amount (USD)' : 'Credits requested'}
          <input type="number" min={unit === 'usd' ? 1 : 1} max={unit === 'usd' ? MAX_TOPUP_CENTS / 100 : MAX_TOPUP_CENTS * 100}
            step={unit === 'usd' ? '0.01' : '1'} required value={value} onChange={(event) => setValue(event.target.value)}
            aria-describedby="topup-quote" className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2" />
        </label>
      </div>
    </fieldset>
    <div id="topup-quote" aria-live="polite" className="text-sm">
      {quote ? <p><strong>{quote.credits.toLocaleString('en-US')} credits</strong> for a <strong>{formatUsd(quote.cents)} USD subtotal</strong>.</p> : <p>Enter $1.00 to $2,500.00, or a positive whole credit quantity.</p>}
      {quote && <p className="mt-1 text-xs text-zinc-500">Whop calculates and adds applicable tax based on the buyer&apos;s location.</p>}
      {unit === 'credits' && <p className="mt-1 text-xs text-zinc-500">Charges round up to the next cent, with a $1.00 minimum. You receive all credits covered by the displayed amount.</p>}
    </div>
    <label className="flex items-start gap-2 text-xs leading-5 text-zinc-600"><input type="checkbox" required className="mt-1" />
      <span>I agree to the <a href="/billing-terms" target="_blank" rel="noreferrer" className="underline">billing terms</a>. This is a one-time purchase.</span>
    </label>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button type="submit" disabled={!enabled || pending || !quote} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50">
      {pending ? 'Opening checkout...' : enabled ? 'Buy credits with Whop' : 'Currently unavailable'}
    </button>
  </form>;
}
