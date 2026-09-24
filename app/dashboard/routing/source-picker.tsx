'use client';

import { useActionState, useState } from 'react';
import { MODALITY_LABELS, type Family, type Modality } from '@/lib/ai/source-types';
import type { Source } from '@/lib/ai/sources';
import { saveRoutingAction } from './actions';

export function SourcePicker({
  family,
  modality,
  sources,
  selected,
}: {
  family: Family;
  modality: Modality;
  sources: Source[];
  selected: string;
}) {
  const [message, action, pending] = useActionState(saveRoutingAction, '');
  const [choice, setChoice] = useState(selected);
  const selectedSource = sources.find((source) => source.id === choice);
  const description = selectedSource
    ? selectedSource.description || 'Prefer this provider when the requested model is available.'
    : choice
      ? 'This saved provider is unavailable. Choose a provider or Auto and save your preference.'
      : modality === 'chat'
        ? 'Try the default provider, then other providers for this model, followed by any configured backups.'
        : 'Try another provider for the same model if a provider refuses to start the job.';
  return (
    <form action={action} className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
      <input type="hidden" name="family" value={family} />
      <input type="hidden" name="modality" value={modality} />
      <label className="block text-sm font-medium text-zinc-900">
        {family.toUpperCase()}
        <span className="ml-2 rounded bg-zinc-100 px-2 py-0.5 text-xs font-normal text-zinc-600">
          {MODALITY_LABELS[modality]}
        </span>
        <select
          name="sourceId"
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          className="mt-2 block w-full rounded border border-zinc-300 bg-white p-2"
          disabled={pending || !sources.length}
        >
          {sources.length > 0 && (
            <option value="">
              Auto (automatic fallback)
            </option>
          )}
          {!sources.length && <option value="">No providers available</option>}
          {choice && !selectedSource && <option value={choice} disabled>Saved provider unavailable — choose another</option>}
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.label} · ×{source.credit_multiplier}
              {source.is_default ? ' · Default' : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-xs font-normal leading-5 text-zinc-500">{description}</p>
      {selectedSource && (
        <p className="text-xs font-normal text-zinc-500">
          Price multiplier:{' '}
          <span className="font-medium text-zinc-700">×{selectedSource.credit_multiplier}</span>
        </p>
      )}
      <button
        disabled={pending || !sources.length}
        className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save routing'}
      </button>
      {message && (
        <p role="status" className="text-sm text-zinc-600">
          {message}
        </p>
      )}
    </form>
  );
}
