'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import {
  BUTTON_SUBTLE_CLASS,
  IDLE_ACTION,
  INPUT_CLASS,
  type ActionState,
} from '../../_components/action-state';
import { suspendUserAction, unsuspendUserAction } from '../actions';

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={BUTTON_SUBTLE_CLASS} disabled={pending}>
      {pending ? 'Saving…' : label}
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

/**
 * Suspend/unsuspend control. The reason is required so every suspension is
 * attributable in the audit log; suspension is enforced at API-key
 * authentication, so it takes effect on the account's next call.
 */
export function SuspendForm({ userId, suspended }: { userId: string; suspended: boolean }) {
  const [state, action] = useActionState(
    suspended ? unsuspendUserAction : suspendUserAction,
    IDLE_ACTION,
  );

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <input
        name="reason"
        type="text"
        placeholder="reason"
        required
        className={`${INPUT_CLASS} w-48`}
      />
      <SubmitButton label={suspended ? 'Unsuspend' : 'Suspend'} />
      <StateMessage state={state} />
    </form>
  );
}