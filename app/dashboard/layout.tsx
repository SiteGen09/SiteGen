import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/lib/actions/auth';
import { requireUser } from '@/lib/dashboard/session';
import { ThemeToggle } from '../theme-toggle';
import { MobileNav } from './mobile-nav';

const NAV = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/keys', label: 'API Keys' },
  { href: '/dashboard/models', label: 'Models' },
  { href: '/dashboard/status', label: 'Model status' },
  { href: '/dashboard/usage', label: 'Usage' },
  { href: '/dashboard/credentials', label: 'Credentials' },
  { href: '/dashboard/billing', label: 'Billing' },
  { href: '/docs', label: 'Docs' },
] as const;

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
      <MobileNav items={NAV}>{account}</MobileNav>

      <aside className="hidden w-56 shrink-0 flex-col border-r border-zinc-200 bg-white md:flex">
        <Link
          href="/dashboard"
          className="border-b border-zinc-200 px-4 py-4 text-sm font-semibold tracking-tight text-zinc-900"
        >
          sitegen
        </Link>

        <nav className="flex flex-1 flex-col gap-0.5 p-2">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="border-t border-zinc-200 p-4">{account}</div>
      </aside>

      <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 md:px-8 md:py-8 xl:px-10">
        <div className="dashboard-main w-full min-w-0">{children}</div>
      </main>
    </div>
  );
}
