import Link from 'next/link';
import type { ReactNode } from 'react';
import { SitegenLogo } from './sitegen-logo';
import { SUPPORT_EMAIL } from '@/lib/site-config';

export interface LegalSection {
  title: string;
  children: ReactNode;
}

export function LegalPage({
  title,
  description,
  effectiveDate,
  sections,
}: {
  title: string;
  description: string;
  effectiveDate: string;
  sections: LegalSection[];
}) {
  return (
    <main className="min-h-full bg-white text-zinc-800">
      <div className="mx-auto max-w-3xl px-5 py-10 sm:px-6 sm:py-14">
        <header className="border-b border-zinc-200 pb-8">
          <div className="flex items-center justify-between gap-4">
            <Link href="/" aria-label="sitegen home" className="inline-flex text-xl text-zinc-900">
              <SitegenLogo />
            </Link>
            <Link href="/" className="text-sm text-zinc-600 underline underline-offset-2">
              Back to site
            </Link>
          </div>
          <h1 className="mt-8 text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl">{title}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-600">{description}</p>
          <p className="mt-4 text-xs text-zinc-500">Effective {effectiveDate} · Seller: Philip Pasaje · Philippines</p>
        </header>

        <div className="space-y-8 py-8 text-sm leading-7">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="mb-3 text-lg font-semibold text-zinc-950">{section.title}</h2>
              <div className="space-y-3 text-zinc-700">{section.children}</div>
            </section>
          ))}
        </div>

        <footer className="border-t border-zinc-200 pt-6 text-xs leading-6 text-zinc-500">
          <p>Questions about this document or your account? Contact <a className="underline" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</p>
          <nav className="mt-3 flex flex-wrap gap-x-4 gap-y-1" aria-label="Legal pages">
            <Link className="underline" href="/terms">Terms</Link>
            <Link className="underline" href="/privacy">Privacy</Link>
            <Link className="underline" href="/refund-policy">Refund policy</Link>
            <Link className="underline" href="/eula">EULA</Link>
            <Link className="underline" href="/billing-terms">Billing terms</Link>
          </nav>
        </footer>
      </div>
    </main>
  );
}
