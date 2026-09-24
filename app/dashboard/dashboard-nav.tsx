'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_GROUPS = [
  {
    label: 'Help',
    items: [
      { href: '/docs', label: 'Docs', icon: 'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z M20 4h-4a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h3z' },
      { href: '/setup', label: 'Setup', icon: 'M9 3h6v4H9z M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3 M8 14l3 3 5-6' },
    ],
  },
  {
    label: 'General',
    items: [
      { href: '/dashboard', label: 'Overview', icon: 'M3 12h4l3-8 4 16 3-8h4' },
      { href: '/dashboard/keys', label: 'API Keys', icon: 'M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z M10 11v10m0-4h4m-4-3h3' },
      { href: '/dashboard/models', label: 'Models', icon: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z' },
      { href: '/dashboard/status', label: 'Model status', icon: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M6 12h3l2-4 3 8 2-4h2' },
      { href: '/dashboard/usage', label: 'Usage', icon: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6' },
    ],
  },
  {
    label: 'Applications',
    items: [
      { href: '/dashboard/chat', label: 'Chat', icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
    ],
  },
  {
    label: 'Personal',
    items: [
      { href: '/dashboard/billing', label: 'Billing', icon: 'M20 8V5H5a2 2 0 0 0 0 4h16v11H5a2 2 0 0 1-2-2V7 M21 12h-6v5h6 M17 14.5h.01' },
      { href: '/dashboard/credentials', label: 'Credentials', icon: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z M9 12l2 2 4-4' },
      { href: '/dashboard/routing', label: 'Routing', icon: 'M7 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z M21 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z M7 5h9a4 4 0 0 1 0 8H8a3 3 0 0 0 0 6h9' },
    ],
  },
] as const;

export function DashboardNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Consumer navigation" className="space-y-5">
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <h2 className="mb-2 px-3 text-[10px] font-medium uppercase tracking-widest text-zinc-500">
            {group.label}
          </h2>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href
                || (item.href !== '/dashboard' && pathname.startsWith(`${item.href}/`));

              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={`flex min-h-11 items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 md:min-h-9 md:py-1.5 ${
                      active
                        ? 'border-emerald-200 bg-emerald-50 font-medium text-zinc-900'
                        : 'border-transparent text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900'
                    }`}
                  >
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 24 24"
                      className="h-4 w-4 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d={item.icon} />
                    </svg>
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
