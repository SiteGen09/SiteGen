'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * Gives every App Router navigation an immediate visual response. The route
 * loading boundaries still provide the page skeleton, while this thin bar
 * covers cached and very fast transitions where the boundary may not paint.
 */
export function NavigationFeedback() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = useMemo(
    () => pathname + '?' + searchParams.toString(),
    [pathname, searchParams],
  );
  const [pendingRoute, setPendingRoute] = useState<string | null>(null);
  const timeout = useRef<number | null>(null);

  const begin = useCallback((duration = 15000) => {
    setPendingRoute(routeKey);
    if (timeout.current !== null) window.clearTimeout(timeout.current);
    // A failed request should never leave the global indicator stuck forever.
    timeout.current = window.setTimeout(() => setPendingRoute(null), duration);
  }, [routeKey]);

  useEffect(() => {
    if (timeout.current !== null) {
      window.clearTimeout(timeout.current);
      timeout.current = null;
    }
  }, [routeKey]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest('button');
      if (button?.type === 'submit') {
        if (button.form && !button.form.checkValidity()) return;
        begin(6000);
        return;
      }
      const anchor = event.target.closest('a');
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      begin();
    }

    function onSubmit(event: SubmitEvent) {
      // Client forms own their pending state and often call preventDefault.
      // Native/server-action submissions do not, so the global bar covers them.
      if (!event.defaultPrevented) begin(6000);
    }

    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('submit', onSubmit);
    };
  }, [begin]);

  if (pendingRoute !== routeKey) return null;
  return (
    <div className="navigation-feedback" role="status" aria-live="polite" aria-label="Loading page">
      <span className="sr-only">Loading page</span>
    </div>
  );
}
