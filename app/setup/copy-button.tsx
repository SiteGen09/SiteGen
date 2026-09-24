'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Clipboard writes reject on a non-secure origin and in browsers that gate the
 * API behind a permission, so the control reports failure rather than showing a
 * "Copied" state that never happened. The value stays on screen to copy by hand.
 */
export function CopyButton({
  value,
  label = 'Copy',
  className = '',
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`${label} ${value}`}
      className={`inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 ${className}`}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}
