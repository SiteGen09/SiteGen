import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '../_components/legal-page';
import { SUPPORT_EMAIL } from '@/lib/site-config';

export const metadata: Metadata = {
  title: 'Terms of Service - sitegen',
  description: 'Terms governing use of the sitegen AI workspace and API.',
};

const EFFECTIVE_DATE = 'September 22, 2026';

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      description="These terms explain how you may use sitegen, how paid credits work, and what to do when you need support."
      effectiveDate={EFFECTIVE_DATE}
      sections={[
        {
          title: '1. The service and seller',
          children: (
            <>
              <p>sitegen is an AI workspace and developer API operated by Philip Pasaje in the Philippines. The service lets you use supported third-party AI models, create media jobs, and connect applications through our API.</p>
              <p>By creating an account or using sitegen, you agree to these Terms of Service, our <Link className="underline" href="/eula">End User License Agreement</Link>, <Link className="underline" href="/privacy">Privacy Policy</Link>, <Link className="underline" href="/refund-policy">Refund Policy</Link>, and <Link className="underline" href="/billing-terms">Billing Terms</Link>. Whop may also apply its own checkout and platform terms.</p>
            </>
          ),
        },
        {
          title: '2. Accounts and security',
          children: (
            <>
              <p>You must provide accurate account information and keep your password, recovery links, API keys, and redemption codes private. You are responsible for activity performed through your account or keys, except where applicable law says otherwise.</p>
              <p>Contact <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> promptly if you suspect unauthorized access. We may require verification before changing account or billing information.</p>
            </>
          ),
        },
        {
          title: '3. Acceptable use',
          children: (
            <>
              <p>You may use sitegen only for lawful purposes and in a way that respects other people’s rights. You must not use it to create or distribute child sexual abuse material, sexually explicit content involving minors, non-consensual sexual content, fraud, malware, credential theft, unauthorized access, harassment, threats, or content that infringes intellectual property or privacy rights.</p>
              <p>You must not bypass limits, probe other accounts, reverse engineer protected systems, resell access without written permission, or use the service to make high-impact decisions about a person without appropriate human review and legal compliance.</p>
              <p>We may block a request, suspend generation, or restrict an account when we reasonably believe use violates these terms, provider rules, Whop policies, or the law.</p>
            </>
          ),
        },
        {
          title: '4. AI output and third-party models',
          children: (
            <>
              <p>AI output can be inaccurate, incomplete, biased, or unsuitable for your purpose. Review output before relying on it, publishing it, or using it in a decision. You are responsible for checking rights, factual accuracy, safety, and compliance.</p>
              <p>sitegen routes requests to third-party providers. Their availability, content rules, and terms may affect a request. We do not promise that a particular model, provider, style, or result will always be available.</p>
            </>
          ),
        },
        {
          title: '5. Credits, payments, and refunds',
          children: (
            <>
              <p>Paid plans and credit purchases are handled through Whop. Credits are usage units, have no cash value, and cannot be withdrawn, transferred, or traded. The current prices, renewal behavior, and refund process are in the <Link className="underline" href="/billing-terms">Billing Terms</Link> and <Link className="underline" href="/refund-policy">Refund Policy</Link>.</p>
              <p>Subscriptions renew every 30 days until canceled through Whop. Canceling stops future renewals but does not automatically refund a completed period. Statutory consumer rights and Whop’s dispute process remain available.</p>
            </>
          ),
        },
        {
          title: '6. Your content and feedback',
          children: (
            <>
              <p>You retain rights you have in prompts, files, and other content you submit. You grant sitegen the limited permission needed to process that content, provide the requested service, prevent abuse, troubleshoot, and comply with law. See the <Link className="underline" href="/privacy">Privacy Policy</Link> for data handling details.</p>
              <p>If you send suggestions or feedback, you allow us to use them to improve the service without owing you compensation, while keeping any confidential information protected.</p>
            </>
          ),
        },
        {
          title: '7. Availability and limits of liability',
          children: (
            <>
              <p>We work to keep sitegen available, but maintenance, provider outages, network failures, abuse controls, and events outside our reasonable control can interrupt it. The service and output are provided as available and to the extent permitted by law without warranties that every result will be accurate, uninterrupted, or fit for a particular purpose.</p>
              <p>To the extent permitted by law, Philip Pasaje is not liable for indirect, incidental, special, consequential, or lost-profit damages arising from use of the service. Nothing in these terms excludes liability that cannot legally be excluded or limits rights that cannot legally be waived.</p>
            </>
          ),
        },
        {
          title: '8. Changes, suspension, and termination',
          children: (
            <>
              <p>We may update the service or these terms. If a change materially affects paid use, we will provide notice through the service or another reasonable channel. Continued use after the effective date means the updated terms apply.</p>
              <p>You may stop using your account at any time. We may suspend or terminate access for serious or repeated violations, legal requirements, security risks, non-payment, or provider or Whop restrictions. Sections that should reasonably survive termination, including payment records, intellectual property, disclaimers, and liability limits, continue to apply.</p>
            </>
          ),
        },
        {
          title: '9. Governing law and contact',
          children: (
            <>
              <p>These terms are governed by the laws of the Philippines, subject to mandatory consumer protections that apply to you. Contact <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> for account, safety, privacy, or service questions.</p>
              <p>Seller: Philip Pasaje, Philippines.</p>
            </>
          ),
        },
      ]}
    />
  );
}
