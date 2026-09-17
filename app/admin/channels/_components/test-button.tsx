'use client';

import { useState } from 'react';
import { z } from 'zod';

import { BUTTON_SUBTLE_CLASS } from '../../_components/action-state';

const responseSchema = z.object({
  ok: z.boolean(),
  latency_ms: z.number(),
  cost_usd: z.number().nullable(),
  error: z.string().optional(),
});

const errorSchema = z.object({
  error: z.object({ message: z.string() }),
});

type Display = { kind: 'ok'; latency: number; cost: number | null } | { kind: 'error'; message: string };

export function ChannelTestButton({ channelId }: { channelId: string }) {
  const [pending, setPending] = useState(false);
  const [display, setDisplay] = useState<Display | null>(null);

  async function run() {
    setPending(true);
    setDisplay(null);
    try {
      const res = await fetch('/api/admin/channels/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channelId }),
      });
      const body: unknown = await res.json();
      if (!res.ok) {
        const parsed = errorSchema.safeParse(body);
        setDisplay({ kind: 'error', message: parsed.success ? parsed.data.error.message : 'test failed' });
        return;
      }
      const parsed = responseSchema.safeParse(body);
      if (!parsed.success) {
        setDisplay({ kind: 'error', message: 'malformed response' });
        return;
      }
      if (parsed.data.ok) {
        setDisplay({ kind: 'ok', latency: parsed.data.latency_ms, cost: parsed.data.cost_usd });
      } else {
        setDisplay({ kind: 'error', message: parsed.data.error ?? 'call failed' });
      }
    } catch (err) {
      setDisplay({ kind: 'error', message: err instanceof Error ? err.message : 'network error' });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" onClick={run} disabled={pending} className={BUTTON_SUBTLE_CLASS}>
        {pending ? 'Testing…' : 'Test'}
      </button>
      {display !== null && display.kind === 'ok' && (
        <span className="text-xs text-emerald-400">
          ok · {display.latency} ms · {display.cost === null ? 'unpriced' : `$${display.cost.toFixed(6)}`}
        </span>
      )}
      {display !== null && display.kind === 'error' && (
        <span className="max-w-[16rem] break-words text-xs text-rose-400">{display.message}</span>
      )}
    </div>
  );
}
