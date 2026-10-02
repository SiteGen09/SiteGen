'use client';

import { useActionState } from 'react';
import { transferRewardsAction, type TransferState } from './actions';

const IDLE: TransferState = { status: 'idle' };

export function TransferButton({ disabled }: { disabled: boolean }) {
  const [state, action, pending] = useActionState(transferRewardsAction, IDLE);
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <button type="submit" disabled={disabled || pending}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50">
        {pending ? 'Transferring…' : 'Transfer to balance'}
      </button>
      {state.status !== 'idle' && (
        <p role={state.status === 'error' ? 'alert' : 'status'}
          className={`text-sm ${state.status === 'error' ? 'text-red-700' : 'text-emerald-700'}`}>
          {state.message}
        </p>
      )}
    </form>
  );
}
