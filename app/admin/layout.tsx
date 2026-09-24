import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { requireAdmin, type AdminContext } from '@/lib/api/admin';
import { AdminNav } from './_components/admin-nav';
import { SitegenLogo } from '../_components/sitegen-logo';

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
            <Link href="/admin" aria-label="sitegen admin" className="inline-flex shrink-0 items-center gap-2.5 text-xl text-zinc-50">
              <SitegenLogo />
              <span className="rounded border border-zinc-700 px-1.5 py-1 text-[10px] font-medium tracking-wider text-zinc-400">ADMIN</span>
            </Link>
            <span className="truncate text-xs text-zinc-500 md:hidden">
              {ctx.user.email ?? ctx.user.id}
            </span>
          </div>
          <AdminNav />
          <span className="hidden shrink-0 text-xs text-zinc-500 xl:inline">
            {ctx.user.email ?? ctx.user.id}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
