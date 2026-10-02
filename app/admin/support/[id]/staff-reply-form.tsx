'use client';

import { useActionState, useEffect, useRef } from 'react';

import { BODY_MAX } from '@/lib/support/types';
import { BUTTON_CLASS, IDLE_ACTION, INPUT_CLASS, LABEL_CLASS } from '../../_components/action-state';
import { replyToTicket } from '../actions';

export function StaffReplyForm({ id }: { id: string }) {
  const [state, action, pending] = useActionState(replyToTicket, IDLE_ACTION);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.status === 'success') form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={action} className="space-y-3">
      <input type="hidden" name="id" value={id} />
      <label className={LABEL_CLASS}>
        Reply to the customer
        <textarea name="body" required maxLength={BODY_MAX} rows={6} className={`${INPUT_CLASS} mt-1 resize-y`} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          After sending, mark as
          <select name="status" defaultValue="answered" className={`${INPUT_CLASS} w-auto py-1.5`}>
            <option value="answered">Answered (waiting on customer)</option>
            <option value="closed">Closed (resolved)</option>
            <option value="open">Open (still on us)</option>
          </select>
        </label>
        <button type="submit" disabled={pending} className={`${BUTTON_CLASS} ml-auto`}>
          {pending ? 'Sending…' : 'Send reply'}
        </button>
      </div>
      {state.status !== 'idle' && (
        <p role={state.status === 'error' ? 'alert' : 'status'} className={`text-xs ${state.status === 'error' ? 'text-rose-300' : 'text-emerald-300'}`}>
          {state.message}
        </p>
      )}
    </form>
  );
}
