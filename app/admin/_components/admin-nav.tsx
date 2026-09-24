'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_GROUPS = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    items: [
      { href: '/admin', label: 'Overview' },
      { href: '/admin/audit', label: 'Audit Log' },
    ],
  },
  {
    id: 'users',
    label: 'Users',
    items: [{ href: '/admin/users', label: 'Users' }],
  },
  {
    id: 'providers',
    label: 'Providers',
    items: [
      { href: '/admin/channels', label: 'Channels' },
      { href: '/admin/sources', label: 'Sources' },
      { href: '/admin/credentials', label: 'Credentials' },
    ],
  },
  {
    id: 'payment',
    label: 'Payment',
    items: [
      { href: '/admin/orders', label: 'Orders' },
      { href: '/admin/disputes', label: 'Disputes' },
      { href: '/admin/leaderboard', label: 'Leaderboard' },
      { href: '/admin/redemption-codes', label: 'Codes' },
    ],
  },
] as const;

function isActive(pathname: string, href: string) {
  return pathname === href || (href !== '/admin' && pathname.startsWith(`${href}/`));
}

export function AdminNav() {
  const pathname = usePathname();

  // A navigation, including browser back/forward, closes any open disclosure.
  return <Navigation key={pathname} pathname={pathname} />;
}

function Navigation({ pathname }: { pathname: string }) {
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (openGroup === null) return;

    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !navRef.current?.contains(event.target)) {
        setOpenGroup(null);
      }
    }

    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [openGroup]);

  return (
    <nav ref={navRef} aria-label="Admin navigation" className="relative min-w-0 md:flex-1">
      <ul className="flex flex-wrap items-center gap-1">
        {NAV_GROUPS.map((group) => {
          const active = group.items.some((item) => isActive(pathname, item.href));
          const open = openGroup === group.id;
          const controlClassName = `inline-flex min-h-11 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300 sm:px-3 sm:text-sm md:min-h-9 ${
            active || open
              ? 'bg-zinc-800 text-zinc-50'
              : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
          }`;

          return (
            <li
              key={group.id}
              className="sm:relative"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                  setOpenGroup((current) => current === group.id ? null : current);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && open) {
                  event.preventDefault();
                  setOpenGroup(null);
                  event.currentTarget.querySelector('button')?.focus();
                }
              }}
            >
              {group.items.length === 1 ? (
                <Link
                  href={group.items[0].href}
                  aria-current={active ? 'page' : undefined}
                  className={controlClassName}
                >
                  {group.label}
                </Link>
              ) : (
                <>
                  <button
                    id={`admin-nav-${group.id}`}
                    type="button"
                    aria-expanded={open}
                    aria-controls={`admin-nav-${group.id}-links`}
                    aria-current={active ? 'true' : undefined}
                    className={controlClassName}
                    onClick={() => setOpenGroup(open ? null : group.id)}
                  >
                    {group.label}
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 20 20"
                      className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m5 7.5 5 5 5-5" />
                    </svg>
                  </button>
                  <ul
                    id={`admin-nav-${group.id}-links`}
                    aria-labelledby={`admin-nav-${group.id}`}
                    hidden={!open}
                    className="absolute inset-x-0 top-full z-50 mt-2 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl shadow-black/30 sm:left-0 sm:right-auto sm:min-w-44"
                  >
                    {group.items.map((item) => {
                      const current = isActive(pathname, item.href);

                      return (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            aria-current={current ? 'page' : undefined}
                            onClick={() => setOpenGroup(null)}
                            className={`flex min-h-11 items-center whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-zinc-300 md:min-h-9 ${
                              current
                                ? 'bg-zinc-800 font-medium text-zinc-50'
                                : 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50'
                            }`}
                          >
                            {item.label}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
