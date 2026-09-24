import Link from 'next/link';
import { SitegenLogo } from '../_components/sitegen-logo';
import { SUPPORT_EMAIL } from '@/lib/site-config';

export const metadata = { title: 'Billing terms - sitegen' };

export default function BillingTerms() {
  return <main className="mx-auto max-w-3xl px-5 py-12 text-zinc-800">
    <Link href="/" aria-label="sitegen home" className="mb-8 inline-flex text-xl text-zinc-900"><SitegenLogo /></Link>
    <h1 className="text-2xl font-semibold">Billing terms</h1>
    <p className="mt-2 text-sm text-zinc-500">Effective September 22, 2026 · Seller: Philip Pasaje · Philippines</p>
    <div className="mt-8 space-y-5 text-sm leading-7">
      <p>Credits prepay usage of sitegen AI services. $1 USD purchases 10,000 credits. Credits are not money, an investment, or a digital currency. They cannot be transferred, traded, or withdrawn as cash.</p>
      <p>Starter costs $14.99 and includes 149,000 credits per paid 30-day period. Pro costs $29.99 and includes 299,000 credits. Max costs $49.99 and includes 499,000 credits. Subscriptions renew automatically every 30 days until canceled through your Whop orders. Cancellation stops future renewals; access continues for the paid period according to the membership status on Whop.</p>
      <p>Top-ups are one-time purchases from $1 to $2,500 USD. Every $1 purchases 10,000 credits; there are no automatic top-up bonuses unless a clearly labeled promotion says otherwise. The amount entered is the pre-tax subtotal. Whop calculates and adds applicable tax at checkout based on the buyer&apos;s location. Taxes and any buyer fees do not purchase additional credits.</p>
      <p>Credits are delivered after payment is confirmed. Unused credits remain available until consumed while your account and the service remain available, subject to these terms and applicable law. Purchasing credits does not promise lifetime service access. Credit use is measured at the model prices shown in the service; rates and model availability may change.</p>
      <p>For payment support or a refund request, open the purchase in <a className="underline" href="https://whop.com/@me/settings/orders/">Whop orders</a> and contact the seller or use Whop&apos;s Resolution Center. For account or technical problems, email <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. See the <Link className="underline" href="/refund-policy">Refund Policy</Link> for the 7-day request window, unused-credit rule, and exceptions. Approved refunds adjust the related credits. Previously consumed credits may leave a negative balance. Statutory consumer rights are not waived.</p>
      <p>Use must comply with applicable law, provider requirements, and <a className="underline" href="https://whop.com/tos/">Whop&apos;s terms</a>. Illegal content, fraud, unauthorized access, intellectual property infringement, and prohibited sexual content are not permitted.</p>
      <p>A payment dispute freezes new AI usage, purchases, and code redemption while the payment is reviewed. You can still sign in to view billing history and contact the seller through Whop orders. Resolved disputes require an account review before the freeze is lifted. This does not limit your right to dispute a charge or seek a refund.</p>
      <p>Redemption codes grant the stated service credits once per account, subject to the code’s expiry and total redemption limit. Codes have no cash value. Keep codes private until shared with their intended recipients.</p>
      <p>Whop processes payment details through its checkout embedded on this site under its <a className="underline" href="https://whop.com/privacy/">privacy policy</a>. A bank or payment provider may require a separate authorization window. We send your sitegen account identifier and purchase information to associate payments with your account. We retain payment identifiers, billing status, and accounting records to deliver credits, handle refunds, and resolve payment issues. Full card details are not collected by sitegen. Contact the seller through Whop orders for billing data questions or requests.</p>
    </div>
    <nav className="mt-8 flex flex-wrap gap-x-4 gap-y-2 text-sm" aria-label="Legal pages">
      <Link className="underline" href="/terms">Terms</Link>
      <Link className="underline" href="/privacy">Privacy</Link>
      <Link className="underline" href="/refund-policy">Refund policy</Link>
      <Link className="underline" href="/eula">EULA</Link>
      <Link className="underline" href="/dashboard/billing">Back to billing</Link>
    </nav>
  </main>;
}
