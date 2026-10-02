import Link from 'next/link';

import type { NotificationItem } from '@/lib/notifications/feed';
import { dismissNotificationAction } from './actions';

/** The newest unread important notice, above every dashboard page until dismissed or read. */
export function NotificationBanner({ item }: { item: NotificationItem }) {
  return (
    <div role="status" className="mb-5 flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium">{item.title}</p>
        <p className="mt-0.5 line-clamp-2 whitespace-pre-line break-words text-amber-800">{item.body}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Link href="/dashboard/notifications" className="font-medium underline">
          View
        </Link>
        <form action={dismissNotificationAction}>
          <input type="hidden" name="id" value={item.id} />
          <button type="submit" className="rounded px-1 font-medium text-amber-800 hover:bg-amber-100" aria-label={`Dismiss: ${item.title}`}>
            Dismiss
          </button>
        </form>
      </div>
    </div>
  );
}
