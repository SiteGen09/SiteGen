import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '../_components/legal-page';
import { SUPPORT_EMAIL } from '@/lib/site-config';

export const metadata: Metadata = {
  title: 'Refund Policy - sitegen',
  description: 'Refund terms for sitegen subscriptions and prepaid credits.',
};

const EFFECTIVE_DATE = 'September 22, 2026';

export default function RefundPolicyPage() {
  return (
    <LegalPage
      title="Refund Policy"
      description="A clear, limited refund process for sitegen subscriptions and prepaid credit purchases."
      effectiveDate={EFFECTIVE_DATE}
      sections={[
        {
          title: '1. Request window',
          children: (
            <p>Contact us through the relevant <a className="underline" href="https://whop.com/@me/settings/orders/">Whop order</a> or email <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> within 7 calendar days of the charge. Include the Whop order identifier, account email, and a short description of the issue. Do not include full payment card details.</p>
          ),
        },
        {
          title: '2. Unused credit refunds',
          children: (
            <p>For a timely request, we may refund the unused portion of credits purchased in that transaction. We determine the unused portion from the related ledger and usage records. Credits already consumed by AI requests, including requests that produced output you did not use, are generally non-refundable because the provider cost has already been incurred.</p>
          ),
        },
        {
          title: '3. When we will review an exception',
          children: (
            <ul className="list-disc space-y-2 pl-5">
              <li>Duplicate charges, an unauthorized transaction, or a payment that was taken without the promised fulfillment.</li>
              <li>A material service failure that prevented the purchased credits or membership from being delivered and could not be corrected within a reasonable time.</li>
              <li>A refund or remedy required by applicable law, Whop policy, or the payment provider’s rules.</li>
            </ul>
          ),
        },
        {
          title: '4. Subscriptions and cancellations',
          children: (
            <p>Cancel a subscription through Whop to stop the next renewal. Cancellation normally does not refund the current paid period, but the unused-credit rule and the exceptions above still apply to an eligible request. A canceled membership may continue until the end of its paid period according to Whop’s status.</p>
          ),
        },
        {
          title: '5. Processing and credit adjustment',
          children: (
            <p>Approved refunds are sent through Whop to the original payment method where possible. We may remove or adjust the credits associated with the refunded transaction, including promotional credits. If credits were consumed before approval, the account may show a corresponding negative balance that must be resolved before further paid use.</p>
          ),
        },
        {
          title: '6. Disputes and legal rights',
          children: (
            <>
              <p>This policy does not remove any non-waivable consumer rights or the right to use Whop’s Resolution Center or your payment provider’s dispute process. Please contact us first where practical so we can investigate the ledger and resolve an error quickly.</p>
              <p>For the full service rules, see the <Link className="underline" href="/terms">Terms of Service</Link> and <Link className="underline" href="/billing-terms">Billing Terms</Link>.</p>
            </>
          ),
        },
      ]}
    />
  );
}
