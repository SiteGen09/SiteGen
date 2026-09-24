'use client';

import { useActionState } from 'react';
import { BUTTON_CLASS, IDLE_ACTION, INPUT_CLASS, LABEL_CLASS } from '../../_components/action-state';
import { createRedemptionCodeAction } from '../actions';

export function CreateRedemptionCodeForm() {
  const [state, action, pending] = useActionState(createRedemptionCodeAction, IDLE_ACTION);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <label className={LABEL_CLASS}>Credits<input className={`${INPUT_CLASS} mt-1`} name="credits" type="number" min="1" max="100000000" step="1" required placeholder="100000" /></label>
      <label className={LABEL_CLASS}>Max redemptions<input className={`${INPUT_CLASS} mt-1`} name="maxRedemptions" type="number" min="1" max="100000" step="1" defaultValue="1" required /></label>
      <label className={LABEL_CLASS}>Expires at (UTC)<input className={`${INPUT_CLASS} mt-1`} name="expiresAt" type="datetime-local" /></label>
      <label className={LABEL_CLASS}>Internal label<input className={`${INPUT_CLASS} mt-1`} name="label" maxLength={120} placeholder="Launch giveaway" /></label>
      <div className="sm:col-span-2 lg:col-span-4">
        <button type="submit" disabled={pending} className={BUTTON_CLASS}>{pending ? 'Creating...' : 'Create redemption code'}</button>
        {state.status !== 'idle' && <p role={state.status === 'error' ? 'alert' : 'status'} className={`mt-3 text-sm ${state.status === 'error' ? 'text-rose-400' : 'text-emerald-300'}`}>{state.message}</p>}
      </div>
    </form>
  );
}
