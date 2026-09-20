'use client';

import { useActionState, useState } from 'react';
import { isProvider, PROVIDERS, PROVIDER_LABELS, requiresBaseUrl, type Provider } from '@/lib/ai/providers';
import {
  addCredential,
  revokeCredential,
  type CredentialState,
} from '@/lib/actions/credentials';

/** Client forms for the credentials page: server actions only, no server modules. */

const INPUT_CLASS =
  'w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500';

export function AddCredentialForm() {
  const [state, action, pending] = useActionState<CredentialState, FormData>(addCredential, {
    status: 'idle',
  });
  const [provider, setProvider] = useState<Provider>('anthropic');
  const needsBaseUrl = requiresBaseUrl(provider);

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="provider" className="text-sm font-medium text-zinc-700">
          Provider
        </label>
        <select
          id="provider"
          name="provider"
          value={provider}
          onChange={(event) => {
            const next = event.target.value;
            setProvider(isProvider(next) ? next : 'anthropic');
          }}
          className={INPUT_CLASS}
        >
          {PROVIDERS.map((value) => (
            <option key={value} value={value}>
              {PROVIDER_LABELS[value]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="api_key" className="text-sm font-medium text-zinc-700">
          API key
        </label>
        <input
          id="api_key"
          name="api_key"
          type="password"
          required
          autoComplete="off"
          spellCheck={false}
          className={`${INPUT_CLASS} font-mono`}
        />
        <p className="text-xs text-zinc-500">
          Verified with one minimal live request before it is saved.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="base_url" className="text-sm font-medium text-zinc-700">
          Base URL {needsBaseUrl ? '(your gateway)' : '(not used by Anthropic)'}
        </label>
        <input
          id="base_url"
          name="base_url"
          type="url"
          required={needsBaseUrl}
          placeholder="https://api.example.com/v1"
          className={`${INPUT_CLASS} font-mono`}
        />
      </div>

      <div className="flex items-center gap-3 sm:col-span-2 xl:col-span-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {pending ? 'Verifying…' : 'Verify and save'}
        </button>
        {state.status === 'saved' && (
          <p className="text-sm text-emerald-700">Credential verified and saved.</p>
        )}
      </div>

      {state.status === 'error' && (
        <p
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 sm:col-span-2 xl:col-span-3"
        >
          {state.message}
        </p>
      )}
    </form>
  );
}

export function RevokeCredentialForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState<CredentialState, FormData>(revokeCredential, {
    status: 'idle',
  });

  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-red-700 underline hover:text-red-900 disabled:opacity-50"
      >
        {pending ? 'Revoking…' : 'Revoke'}
      </button>
      {state.status === 'error' && (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {state.message}
        </p>
      )}
    </form>
  );
}
