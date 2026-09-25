'use client';

import { useActionState, useState } from 'react';
import { saveDefaultProviderAction } from './actions';

export function DefaultProviderPicker({
  providers,
  selected,
  platformLabel,
}: {
  providers: { publicId: string; label: string }[];
  selected: string;
  platformLabel: string | null;
}) {
  const [message, action, pending] = useActionState(saveDefaultProviderAction, '');
  const [choice, setChoice] = useState(selected);
  const saved = providers.some((provider) => provider.publicId === choice);
  return (
    <form action={action} className="mb-4 space-y-3 rounded-lg border border-zinc-200 bg-white p-4">
      <label className="block text-sm font-medium text-zinc-900">
        Default provider
        <select
          name="providerId"
          value={choice}
          onChange={(event) => setChoice(event.target.value)}
          className="mt-2 block w-full max-w-md rounded border border-zinc-300 bg-white p-2"
          disabled={pending || !providers.length}
        >
          <option value="">Auto{platformLabel ? ` (platform default: ${platformLabel})` : ''}</option>
          {choice && !saved && <option value={choice} disabled>Saved provider unavailable — choose another</option>}
          {providers.map((provider) => (
            <option key={provider.publicId} value={provider.publicId}>
              {provider.label}
            </option>
          ))}
        </select>
      </label>
      <p className="max-w-3xl text-xs leading-5 text-zinc-500">
        Every model starts on this provider when it serves that model, then falls back to the
        others. A choice for a specific model family below overrides it.
      </p>
      <button
        disabled={pending || !providers.length}
        className="rounded bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save default'}
      </button>
      {message && (
        <p role="status" className="text-sm text-zinc-600">
          {message}
        </p>
      )}
    </form>
  );
}
