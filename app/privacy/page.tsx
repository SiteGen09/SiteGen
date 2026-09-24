import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '../_components/legal-page';
import { SUPPORT_EMAIL } from '@/lib/site-config';

export const metadata: Metadata = {
  title: 'Privacy Policy - sitegen',
  description: 'How sitegen collects, uses, stores, and protects account and usage information.',
};

const EFFECTIVE_DATE = 'September 22, 2026';

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      description="This policy describes the personal information used to provide sitegen, process payments, secure accounts, and answer support requests."
      effectiveDate={EFFECTIVE_DATE}
      sections={[
        {
          title: '1. Who is responsible',
          children: (
            <p>Philip Pasaje, Philippines, operates sitegen and is responsible for the information described here. For privacy questions or requests, email <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
          ),
        },
        {
          title: '2. Information we collect',
          children: (
            <>
              <p><strong>Account information:</strong> email address, display name, authentication identifiers, and account status. If you use Google sign-in, Supabase Auth receives the identity information provided by Google.</p>
              <p><strong>Usage and content:</strong> prompts, messages, files or media you submit, model and routing choices, API key metadata, request identifiers, usage counts, credit charges, and error or safety events. Provider credentials are encrypted server-side; sitegen stores identifiers and encrypted credential material needed to use a connected provider.</p>
              <p><strong>Billing information:</strong> Whop processes payment details. sitegen receives purchase identifiers, plan or product information, payment status, account association, and records needed for fulfillment, refunds, accounting, and disputes. sitegen does not collect full card numbers.</p>
              <p><strong>Technical information:</strong> security and diagnostic logs, approximate request timing, device or browser information available to the service, and a keyed hash used for rate-limit buckets when trusted proxy information is configured.</p>
            </>
          ),
        },
        {
          title: '3. How we use information',
          children: (
            <ul className="list-disc space-y-2 pl-5">
              <li>Provide authentication, AI requests, media jobs, usage records, credit balances, and support.</li>
              <li>Process Whop purchases, renewals, refunds, redemptions, payment disputes, and fraud or abuse reviews.</li>
              <li>Secure the service, enforce limits, investigate misuse, apply content policies, and protect users and providers.</li>
              <li>Diagnose errors, measure reliability, improve the product, and comply with legal obligations.</li>
            </ul>
          ),
        },
        {
          title: '4. Providers and sharing',
          children: (
            <>
              <p>We share the minimum information needed with service providers that host the database, authenticate accounts, process payments, deliver email, store generated media, or run the AI model you select. Model providers receive the prompt, required inputs, and technical request data needed to complete the request. Their own privacy terms may apply.</p>
              <p>We may disclose information when required by law, to protect rights and safety, to investigate fraud or abuse, or as part of a business transfer. We do not sell personal information.</p>
            </>
          ),
        },
        {
          title: '5. Retention and security',
          children: (
            <>
              <p>We retain account, billing, usage, and security records for as long as needed to provide the service, resolve disputes, meet accounting or legal requirements, and enforce agreements. Prompts, messages, and generated media remain available according to the account and product features unless deleted or removed for policy or operational reasons.</p>
              <p>We use access controls, encrypted connections, server-side encryption for provider credentials, and private media storage. No online service can guarantee absolute security, so protect your password, API keys, and redemption codes.</p>
            </>
          ),
        },
        {
          title: '6. Your choices and rights',
          children: (
            <>
              <p>You may update account details, disconnect provider credentials, manage Whop billing, and ask for access, correction, deletion, or an explanation of processing by emailing <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. We may need to verify your request and may retain information where the law permits or requires it.</p>
              <p>You can stop receiving optional messages through the available unsubscribe control. Service, security, transaction, and account messages may still be sent when necessary.</p>
            </>
          ),
        },
        {
          title: '7. Cookies and international transfers',
          children: (
            <>
              <p>sitegen uses cookies or similar storage required for authentication, security, preferences, and basic operation. We do not use them to sell personal information.</p>
              <p>Our providers may process information in countries outside the Philippines. We select providers that offer contractual, technical, or organizational safeguards appropriate to the service and the information involved.</p>
            </>
          ),
        },
        {
          title: '8. Children and policy changes',
          children: (
            <>
              <p>sitegen is not intended for children who cannot lawfully use an AI service without required consent. If you believe a child provided information improperly, contact us so we can review it.</p>
              <p>We may update this policy as the service or law changes. We will post the new effective date and provide additional notice when required.</p>
              <p>Read the <Link className="underline" href="/terms">Terms of Service</Link> for the broader rules governing use of sitegen.</p>
            </>
          ),
        },
      ]}
    />
  );
}
