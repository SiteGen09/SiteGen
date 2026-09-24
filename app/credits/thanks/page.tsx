import Link from 'next/link';
import { z } from 'zod';
import { requireUser } from '@/lib/dashboard/session';
import { getBalance } from '@/lib/dashboard/queries';
import { CheckoutPoller } from '@/app/dashboard/billing/checkout-poller';

export const metadata = { title: 'Confirming your credits - sitegen', robots: { index: false, follow: false } };

export default async function CreditsThanksPage({ searchParams }: { searchParams: Promise<{ purchase?: string }> }) {
  await requireUser();
  const [params, balance] = await Promise.all([searchParams, getBalance()]);
  const purchase = z.uuid().safeParse(params.purchase);
  return <main className="mx-auto w-full max-w-xl px-6 py-16">
    <h1 className="mb-4 text-2xl font-semibold">Thanks for your purchase</h1>
    {purchase.success ? <CheckoutPoller purchaseId={purchase.data} /> : <p className="mb-6 text-sm">Check your billing history for confirmation of your purchase.</p>}
    <p className="mb-6 text-sm">Available balance: <strong>{balance.toLocaleString('en-US')} credits</strong>.</p>
    <Link href="/dashboard/billing" className="text-sm underline">Return to billing</Link>
  </main>;
}
