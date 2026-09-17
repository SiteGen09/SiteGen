'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';

/**
 * Narrow-viewport counterpart to the dashboard sidebar, which is hidden below
 * `md`. Client-side only because the panel has to close itself once a
 * navigation lands — a plain <details> would stay open across it.
 */
export function MobileNav({
  items,
  children,
}: {
  items: readonly { readonly href: string; readonly label: string }[];
  children: ReactNode;
}) {
  const pathname = usePathname();
  // Storing the route the panel was opened on, rather than a bare boolean,
  // means any navigation closes it without an effect chasing the pathname.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;

  return (
    <div className="border-b border-zinc-200 bg-white md:hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2">
        <Link
          href="/dashboard"
          className="-ml-1 inline-flex min-h-11 items-center rounded-md px-1 text-sm font-semibold tracking-tight text-zinc-900"
        >
          sitegen
        </Link>
        <button
          type="button"
          onClick={() => setOpenedOn(open ? null : pathname)}
          aria-expanded={open}
          aria-controls="dashboard-mobile-nav"
          className="-mr-1 inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
        >
          Menu
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 7.5 10 12.5 15 7.5" />
          </svg>
        </button>
      </div>

      <div id="dashboard-mobile-nav" hidden={!open} className="border-t border-zinc-200 px-2 py-2">
        <nav className="flex flex-col gap-0.5">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="flex min-h-11 items-center rounded-md px-3 text-sm text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mt-2 border-t border-zinc-200 px-3 pt-3">{children}</div>
      </div>
    </div>
  );
}
