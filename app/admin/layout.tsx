import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { requireAdmin, type AdminContext } from '@/lib/api/admin';

const NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/channels', label: 'Channels' },
  { href: '/admin/sources', label: 'Sources' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/credentials', label: 'Credentials' },
  { href: '/admin/audit', label: 'Audit Log' },
] as const;

export default async function AdminLayout({ children }: { children: ReactNode }) {
  let ctx: AdminContext | null = null;
  try {
    ctx = await requireAdmin();
  } catch {
    // Any failure to prove admin — no session or wrong role — leaves the portal.
    ctx = null;
  }
  if (ctx === null) {
    redirect('/dashboard');
  }

  return (
    // `admin-scope` pins the colour tokens to their stock values: this portal
    // is deliberately dark in both themes and sits out of the theme switch.
    <div className="admin-scope min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-3 sm:px-6 md:flex-row md:items-center md:gap-6">
          <div className="flex min-w-0 items-center justify-between gap-4">
            <span className="shrink-0 text-sm font-semibold tracking-tight text-zinc-50">
              sitegen admin
            </span>
            <span className="truncate text-xs text-zinc-500 md:hidden">
              {ctx.user.email ?? ctx.user.id}
            </span>
          </div>
          {/* Below `md` the tabs scroll sideways instead of wrapping into rows. */}
          <nav className="-mx-4 flex items-center gap-1 overflow-x-auto px-4 text-sm sm:-mx-6 sm:px-6 md:mx-0 md:flex-1 md:overflow-x-visible md:px-0">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <span className="hidden shrink-0 text-xs text-zinc-500 md:inline">
            {ctx.user.email ?? ctx.user.id}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
