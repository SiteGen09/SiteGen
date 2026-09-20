'use client';

import { useActionState } from 'react';
import type { Family, Source } from '@/lib/ai/sources';
import { saveRoutingAction } from './actions';

export function SourcePicker({
  family,
  sources,
  selected,
}: {
  family: Family;
  sources: Source[];
  selected: string;
}) {
  const [message, action, pending] = useActionState(saveRoutingAction, '');
  return (
    <form action={action} className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
      <input type="hidden" name="family" value={family} />
      <label className="block text-sm font-medium text-zinc-900">
        {family.toUpperCase()}
        <select
          name="sourceId"
          defaultValue={selected}
          className="mt-2 block w-full rounded border border-zinc-300 bg-white p-2"
          disabled={!sources.length}
        >
          {sources.length > 0 && (
            <option value="" disabled>
              Choose a source (automatic routing)
            </option>
          )}
          {!sources.length && <option value="">No sources available</option>}
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.label} · ×{source.credit_multiplier}
              {source.is_default ? ' · Default' : ''}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={pending || !sources.length}
        className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save source'}
      </button>
      {message && (
        <p role="status" className="text-sm text-zinc-600">
          {message}
        </p>
      )}
    </form>
  );
}
