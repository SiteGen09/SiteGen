'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { z } from 'zod';

/**
 * Post-checkout waiting room. The Whop redirect grants nothing — only the
 * webhook mutates entitlements — so after `?pending=1` we poll
 * /api/billing/status until the plan or status actually moves, then refresh the
 * server-rendered page.
 */

const POLL_MS = 3_000;
const MAX_ATTEMPTS = 40; // 40 × 3s = 2 minutes

const statusSchema = z.object({
  plan_key: z.string(),
  status: z.string(),
});

type Phase = 'waiting' | 'settled' | 'timeout';

export function CheckoutPoller({
  initialPlanKey,
  initialStatus,
}: {
  initialPlanKey: string;
  initialStatus: string;
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
        const response = await fetch('/api/billing/status', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.ok) {
          const parsed = statusSchema.safeParse(await response.json());
          if (
            parsed.success &&
            (parsed.data.plan_key !== initialPlanKey || parsed.data.status !== initialStatus)
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
  }, [initialPlanKey, initialStatus, router]);

  if (phase === 'settled') {
    return (
      <p className="mb-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        Payment confirmed. Your plan is up to date.
      </p>
    );
  }

  if (phase === 'timeout') {
    return (
      <p className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Still waiting on confirmation from Whop. Your payment is safe — this page updates as soon
        as the webhook lands. Reload in a minute, or contact support if the charge went through and
        nothing changed.
      </p>
    );
  }

  return (
    <p className="mb-6 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
      Confirming your payment with Whop. This page updates itself — no need to reload.
    </p>
  );
}
