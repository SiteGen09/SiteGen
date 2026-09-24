'use client';

import { useActionState } from 'react';
import { redeemCodeAction, type RedemptionActionState } from './redemption-actions';

const INITIAL_STATE: RedemptionActionState = { status: 'idle' };

export function RedeemCodeForm() {
  const [state, action, pending] = useActionState(redeemCodeAction, INITIAL_STATE);
  return (
    <form action={action} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1">
        <label htmlFor="redemption-code" className="mb-1 block text-sm font-medium text-zinc-700">Have a code?</label>
        <input
          id="redemption-code"
          name="code"
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          placeholder="Enter your redemption code"
          required
          className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm uppercase tracking-wide placeholder:normal placeholder:tracking-normal"
          aria-describedby="redemption-help redemption-result"
        />
        <p id="redemption-help" className="mt-1 text-xs text-zinc-500">Each code can be redeemed once per account, subject to its expiry and total availability.</p>
      </div>
      <button type="submit" disabled={pending} className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50">
        {pending ? 'Redeeming...' : 'Redeem'}
      </button>
      {state.status !== 'idle' && (
        <p id="redemption-result" role={state.status === 'error' ? 'alert' : 'status'} className={`text-sm sm:basis-full ${state.status === 'error' ? 'text-red-700' : 'text-emerald-700'}`}>
          {state.message}
        </p>
      )}
    </form>
  );
}
