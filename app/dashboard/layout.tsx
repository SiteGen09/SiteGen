import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/lib/actions/auth';
import { requireUser } from '@/lib/dashboard/session';
import { ThemeToggle } from '../theme-toggle';
import { MobileNav } from './mobile-nav';
import { DashboardNav } from './dashboard-nav';
import { SitegenLogo } from '../_components/sitegen-logo';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();

  // Rendered in both the sidebar and the mobile disclosure panel. `signOut` is
  // a server action, so the markup is built here and passed down as children.
  const account = (
    <>
      <p className="truncate text-xs text-zinc-500" title={user.email ?? ''}>
        {user.email}
      </p>
      <form action={signOut}>
        <button
          type="submit"
          className="mt-2 text-xs font-medium text-zinc-700 underline hover:text-zinc-900"
        >
          Sign out
        </button>
      </form>
      <ThemeToggle className="mt-3" />
    </>
  );

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-zinc-50 md:flex-row">
      <MobileNav>{account}</MobileNav>

      <aside className="hidden w-56 shrink-0 flex-col border-r border-zinc-200 bg-white md:flex">
        <Link
          href="/dashboard"
          aria-label="sitegen dashboard"
          className="flex items-center border-b border-zinc-200 px-4 py-4 text-xl text-zinc-900"
        >
          <SitegenLogo />
        </Link>

        <div className="flex-1 px-2 py-5">
          <DashboardNav />
        </div>

        <div className="border-t border-zinc-200 p-4">{account}</div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 md:px-8 md:py-8 xl:px-10">
        <div className="dashboard-main w-full min-w-0">{children}</div>
      </main>
    </div>
  );
}
