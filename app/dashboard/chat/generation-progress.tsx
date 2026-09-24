'use client';

import { useEffect, useState } from 'react';

export function GenerationProgress({ startedAt, label }: { startedAt: string; label: string }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const parsed = Date.parse(startedAt);
    const start = Number.isFinite(parsed) ? parsed : Date.now();
    // Use wall time so background-tab throttling doesn't slow the counter.
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    const initial = window.setTimeout(tick, 0);
    const interval = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [startedAt]);

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
      <span aria-hidden="true" className="h-4 w-4 rounded-full border-2 border-zinc-300 border-t-zinc-700 motion-safe:animate-spin" />
      <span>{label}…</span>
      <span role="timer" aria-live="off" aria-label="Generation elapsed time" className="font-medium tabular-nums text-zinc-700">{seconds}s elapsed</span>
    </div>
  );
}
