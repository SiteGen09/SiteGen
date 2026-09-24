'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';

/**
 * Post-checkout waiting room. The Whop redirect grants nothing — only the
 * webhook posts credits. Poll the exact purchase marker, including when the
 * payment already arrived before this page rendered, then refresh the page.
 */

const POLL_MS = 3_000;
const MAX_ATTEMPTS = 40; // 40 × 3s = 2 minutes

const statusSchema = z.object({
  purchase_confirmed: z.boolean(),
});

type Phase = 'waiting' | 'settled' | 'timeout';

export function CheckoutPoller({
  purchaseId,
}: {
  purchaseId: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('waiting');

  useEffect(() => {
    const controller = new AbortController();
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      attempts += 1;
      try {
        const response = await fetch('/api/billing/status?purchase=' + encodeURIComponent(purchaseId), {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.ok) {
          const parsed = statusSchema.safeParse(await response.json());
          if (
            parsed.success &&
            parsed.data.purchase_confirmed
          ) {
            setPhase('settled');
            router.refresh();
            return;
          }
        }
      } catch {
        // Network hiccup or unmount abort: fall through to the next attempt.
      }
      if (controller.signal.aborted) return;
      if (attempts >= MAX_ATTEMPTS) {
        setPhase('timeout');
        return;
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    };

    timer = setTimeout(() => void poll(), POLL_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [purchaseId, router]);

  if (phase === 'settled') {
    return (
      <p className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        Payment confirmed. Your credits are up to date.
      </p>
    );
  }

  if (phase === 'timeout') {
    return (
      <p className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Payment confirmation has not arrived yet. Check your Whop orders before retrying a purchase.
        Reload this page in a minute or contact the seller through Whop if you were charged.
      </p>
    );
  }

  return (
    <p className="mb-6 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
      Confirming your payment with Whop. This page updates itself — no need to reload.
    </p>
  );
}
