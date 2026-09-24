import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '../_components/legal-page';

export const metadata: Metadata = {
  title: 'End User License Agreement - sitegen',
  description: 'License terms for using the sitegen software, workspace, and API.',
};

const EFFECTIVE_DATE = 'September 22, 2026';

export default function EulaPage() {
  return (
    <LegalPage
      title="End User License Agreement"
      description="The license and use rules for the sitegen application, API, documentation, and related software."
      effectiveDate={EFFECTIVE_DATE}
      sections={[
        {
          title: '1. License grant',
          children: (
            <p>Subject to the <Link className="underline" href="/terms">Terms of Service</Link> and your paid access, Philip Pasaje grants you a limited, non-exclusive, non-transferable, revocable license to access and use sitegen, its documentation, and its API for your internal or commercial projects.</p>
          ),
        },
        {
          title: '2. Restrictions',
          children: (
            <p>You may not copy, sell, sublicense, rent, lease, distribute, modify, reverse engineer, interfere with, or create a competing service from sitegen or its protected components, except where applicable law expressly permits it. You may not share API keys or use another person’s account.</p>
          ),
        },
        {
          title: '3. Your content and output',
          children: (
            <p>You keep the rights you have in the prompts and files you submit. Subject to third-party model terms and applicable law, you may use output generated for your account, but you are responsible for checking originality, permissions, accuracy, safety, and any rights held by others. AI output may not be unique.</p>
          ),
        },
        {
          title: '4. Third-party components and providers',
          children: (
            <p>sitegen includes or connects to third-party software, model providers, storage, authentication, and payment services. Those components may have separate licenses, terms, or availability limits. A provider restriction can limit or end access to a feature without creating a right to use that provider outside its own terms.</p>
          ),
        },
        {
          title: '5. Updates and termination',
          children: (
            <p>We may update, replace, or discontinue software or features. This license ends when your account or access ends, or when you breach the applicable terms. On termination, stop using the software and delete stored copies of protected materials except where retention is required by law.</p>
          ),
        },
        {
          title: '6. Disclaimer',
          children: (
            <p>To the extent permitted by law, sitegen is licensed as available without a promise that it will be uninterrupted, error-free, secure, or suitable for a particular purpose. Nothing here limits a right or liability that cannot legally be limited. The <Link className="underline" href="/privacy">Privacy Policy</Link> explains how account and usage data is handled.</p>
          ),
        },
      ]}
    />
  );
}
