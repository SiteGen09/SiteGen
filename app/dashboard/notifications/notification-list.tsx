'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { NotificationItem } from '@/lib/notifications/feed';
import { NOTIFICATION_KIND_LABELS, type NotificationKind } from '@/lib/notifications/types';

const DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
});

const KIND_STYLE: Record<NotificationKind, string> = {
  model_added: 'bg-emerald-50 text-emerald-700',
  model_removed: 'bg-red-50 text-red-700',
  price_change: 'bg-amber-50 text-amber-700',
  announcement: 'bg-blue-50 text-blue-800',
  low_balance: 'bg-red-50 text-red-700',
  key_expiring: 'bg-amber-50 text-amber-700',
  key_quota: 'bg-amber-50 text-amber-700',
  support_reply: 'bg-emerald-50 text-emerald-700',
  upstream_alert: 'bg-red-50 text-red-700',
};

function linkLabel(link: string): string {
  if (link.startsWith('/prices')) return 'View prices';
  if (link.startsWith('/dashboard/models')) return 'View models';
  if (link.startsWith('/dashboard/billing')) return 'Top up';
  if (link.startsWith('/dashboard/keys')) return 'Manage API keys';
  if (link.startsWith('/dashboard/support')) return 'Read the reply';
  if (link.startsWith('/admin/sources')) return 'Manage sources';
  return 'Open';
}

/**
 * The feed. Which items were new is fixed when the page opens: opening it
 * marks everything read and refreshes, and the highlight must survive that.
 */
export function NotificationList({ items }: { items: NotificationItem[] }) {
  const [newOnOpen] = useState(() => new Set(items.filter((item) => !item.read).map((item) => item.id)));

  return (
    <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white">
      {items.map((item) => {
        const isNew = newOnOpen.has(item.id);
        return (
          <li key={item.id} className={`px-4 py-4 sm:px-5 ${isNew ? 'bg-emerald-50/40' : ''}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${KIND_STYLE[item.kind]}`}>
                {NOTIFICATION_KIND_LABELS[item.kind]}
              </span>
              {item.important && (
                <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700">Important</span>
              )}
              {isNew && (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
                  New
                </span>
              )}
              <time dateTime={new Date(item.createdAt).toISOString()} className="ml-auto text-xs text-zinc-500">
                {DATE.format(new Date(item.createdAt))}
              </time>
            </div>
            <h2 className="mt-2 break-words text-sm font-semibold text-zinc-900">{item.title}</h2>
            {item.body && (
              <p className="mt-1 whitespace-pre-line break-words text-sm leading-6 text-zinc-600">{item.body}</p>
            )}
            {item.link && (
              <Link href={item.link} className="mt-2 inline-block text-sm font-medium text-emerald-700 underline hover:text-emerald-800">
                {linkLabel(item.link)}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
