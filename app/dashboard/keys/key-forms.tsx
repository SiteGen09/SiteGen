'use client';

import { useActionState, useState } from 'react';
import {
  createApiKey,
  revokeApiKey,
  type CreateKeyState,
  type RevokeKeyState,
} from '@/lib/actions/keys';

/**
 * Client forms for the keys page. These import only the server actions — no
 * server-only module (crypto, service client, env) is reachable from here.
 */

export function CreateKeyForm() {
  const [state, action, pending] = useActionState<CreateKeyState, FormData>(createApiKey, {
    status: 'idle',
  });

  return (
    <div>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="flex w-full min-w-0 flex-1 flex-col gap-1.5 sm:w-auto sm:max-w-md">
          <label htmlFor="key-name" className="text-sm font-medium text-zinc-700">
            Key name
          </label>
          <input
            id="key-name"
            name="name"
            type="text"
            required
            maxLength={64}
            placeholder="production"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-md bg-zinc-900 px-3 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 sm:w-auto sm:py-2"
        >
          {pending ? 'Creating…' : 'Create key'}
        </button>
      </form>

      {state.status === 'error' && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.message}
        </p>
      )}

      {state.status === 'created' && <NewKeyBanner name={state.name} apiKey={state.key} />}
    </div>
  );
}

function NewKeyBanner({ name, apiKey }: { name: string; apiKey: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-medium text-amber-900">
        Key “{name}” created. Copy it now — it is never shown again.
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 overflow-x-auto rounded border border-amber-200 bg-white px-2.5 py-2 font-mono text-xs text-zinc-900">
          {apiKey}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 rounded-md border border-amber-300 bg-white px-2.5 py-2.5 text-xs font-medium text-amber-900 hover:bg-amber-100 sm:py-2"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function RevokeKeyForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState<RevokeKeyState, FormData>(revokeApiKey, {
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
