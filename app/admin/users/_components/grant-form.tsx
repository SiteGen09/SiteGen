'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import {
  BUTTON_SUBTLE_CLASS,
  IDLE_ACTION,
  INPUT_CLASS,
  type ActionState,
} from '../../_components/action-state';
import { grantCreditsAction } from '../actions';

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={BUTTON_SUBTLE_CLASS} disabled={pending}>
      {pending ? 'Granting…' : 'Grant'}
    </button>
  );
}

function StateMessage({ state }: { state: ActionState }) {
  if (state.status === 'idle') return null;
  return (
    <span className={`text-xs ${state.status === 'error' ? 'text-rose-400' : 'text-emerald-400'}`}>
      {state.message}
    </span>
  );
}

export function GrantForm({ userId }: { userId: string }) {
  const [state, action] = useActionState(grantCreditsAction, IDLE_ACTION);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <input
        name="amount"
        type="number"
        step="1"
        min="1"
        placeholder="credits"
        required
        className={`${INPUT_CLASS} w-28`}
      />
      <input name="reason" type="text" placeholder="reason" required className={`${INPUT_CLASS} w-48`} />
      <SubmitButton />
      <StateMessage state={state} />
    </form>
  );
}
