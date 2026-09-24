import Link from 'next/link';
import type { ReactNode } from 'react';
import { ThemeToggle } from '../theme-toggle';
import { SitegenLogo } from '../_components/sitegen-logo';
import { SUPPORT_EMAIL } from '@/lib/site-config';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 px-4 py-8 sm:py-10">
      <div className="w-full max-w-[480px]">
        <Link
          href="/"
          aria-label="sitegen home"
          className="mb-6 flex justify-center text-2xl text-zinc-900 sm:mb-8"
        >
          <SitegenLogo />
        </Link>
        <main className="rounded-2xl border border-zinc-200 bg-white p-6 sm:p-8">{children}</main>
        <div className="mt-6 flex flex-col items-center gap-2 text-center">
          <p className="text-xs text-zinc-500">Need help? <a className="underline underline-offset-2" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a></p>
          <nav className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs text-zinc-500" aria-label="Legal pages">
            <Link className="underline underline-offset-2" href="/terms">Terms</Link>
            <Link className="underline underline-offset-2" href="/privacy">Privacy</Link>
            <Link className="underline underline-offset-2" href="/refund-policy">Refund policy</Link>
            <Link className="underline underline-offset-2" href="/eula">EULA</Link>
          </nav>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}
