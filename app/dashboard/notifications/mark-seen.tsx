'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { markAllNotificationsReadAction } from './actions';

/**
 * Marks the feed read once it has been shown. The page renders the unread
 * highlight first, then the badge clears on refresh; doing it during render
 * would erase the highlight before the user saw it.
 */
export function MarkSeen({ unread }: { unread: number }) {
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    if (unread === 0 || done.current) return;
    done.current = true;
    void markAllNotificationsReadAction().then(() => router.refresh());
  }, [unread, router]);
  return null;
}
