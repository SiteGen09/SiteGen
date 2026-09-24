'use client';

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const WINDOW_EVENTS = ['focus', 'blur', 'online', 'offline', 'pageshow', 'pagehide'] as const;

function subscribe(onChange: () => void) {
  for (const event of WINDOW_EVENTS) window.addEventListener(event, onChange);
  document.addEventListener('visibilitychange', onChange);
  return () => {
    for (const event of WINDOW_EVENTS) window.removeEventListener(event, onChange);
    document.removeEventListener('visibilitychange', onChange);
  };
}

/** Someone is looking: the tab is showing, the window has focus, and there is a network. */
function isWatching() {
  return document.visibilityState === 'visible' && document.hasFocus() && navigator.onLine;
}

/**
 * Re-renders the current admin route on a timer, but only while the admin is
 * on the page. A background tab, another focused window or a lost connection
 * clears the timer, so nothing is requested while nobody is watching. Coming
 * back refreshes at once if the data is older than one interval, otherwise it
 * waits out the remainder. A quick alt-tab therefore costs nothing.
 *
 * router.refresh() re-runs the page's server queries (and requireAdmin) and
 * merges the result without resetting client state such as half-typed form
 * input. The next tick is only scheduled after the previous refresh lands, so
 * a slow query can never stack requests.
 */
export function LiveRefresh({ renderedAt, intervalMs = 15_000 }: {
  /** When the server rendered this payload (ISO); changes on every refresh. */
  renderedAt: string;
  intervalMs?: number;
}) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [paused, setPaused] = useState(false);
  const watching = useSyncExternalStore(subscribe, isWatching, () => false);
  const running = watching && !paused;
  // Client clock time of the last refresh attempt or payload. Attempts count
  // too, so a failed refresh waits a full interval instead of retrying hot.
  const since = useRef(0);

  useEffect(() => {
    since.current = Date.now();
  }, [renderedAt]);

  useEffect(() => {
    if (!running || refreshing) return;
    const wait = Math.max(0, intervalMs - (Date.now() - since.current));
    const timer = window.setTimeout(() => {
      since.current = Date.now();
      startTransition(() => router.refresh());
    }, wait);
    return () => window.clearTimeout(timer);
  }, [running, refreshing, renderedAt, intervalMs, router]);

  function refreshNow() {
    since.current = Date.now();
    startTransition(() => router.refresh());
  }

  const seconds = Math.round(intervalMs / 1000);
  const status = refreshing ? 'Refreshing…'
    : paused ? 'Paused'
    : watching ? `Live · every ${seconds}s`
    : 'Paused while you are away';

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm">
      <div className="flex min-w-0 items-center gap-2" role="status" aria-live="polite">
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${running ? 'bg-emerald-400' : 'bg-zinc-600'} ${refreshing ? 'animate-pulse' : ''}`} />
        <span className="text-zinc-200">{status}</span>
        <span className="text-zinc-500">
          · updated <time dateTime={renderedAt} suppressHydrationWarning>{new Date(renderedAt).toLocaleTimeString()}</time>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPaused((value) => !value)}
          aria-pressed={paused}
          className="rounded-md border border-zinc-700 px-3 py-1 text-zinc-200 hover:bg-zinc-800"
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          onClick={refreshNow}
          disabled={refreshing}
          className="rounded-md border border-zinc-700 px-3 py-1 text-zinc-200 hover:bg-zinc-800 disabled:text-zinc-600"
        >
          Refresh now
        </button>
      </div>
    </div>
  );
}
