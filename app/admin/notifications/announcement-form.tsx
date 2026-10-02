'use client';

import { useState, useTransition, type FormEvent } from 'react';

import { BUTTON_CLASS, IDLE_ACTION, INPUT_CLASS, LABEL_CLASS, type ActionState } from '../_components/action-state';
import { createAnnouncementAction } from './actions';

export function AnnouncementForm({ plans }: { plans: { key: string; label: string }[] }) {
  const [state, setState] = useState<ActionState>(IDLE_ACTION);
  const [pending, startTransition] = useTransition();
  // Submitted by hand rather than through `action`, which resets the form
  // even when the server refuses it and would throw away a long message.
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    startTransition(async () => {
      const result = await createAnnouncementAction(IDLE_ACTION, data);
      setState(result);
      if (result.status === 'success') form.reset();
    });
  };
  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <label className={`${LABEL_CLASS} sm:col-span-2`}>
        Title
        <input className={`${INPUT_CLASS} mt-1`} name="title" required maxLength={200} placeholder="Scheduled maintenance on Sunday 02:00 UTC" />
      </label>
      <label className={`${LABEL_CLASS} sm:col-span-2`}>
        Message
        <textarea className={`${INPUT_CLASS} mt-1 min-h-28`} name="body" maxLength={5000} placeholder="What changes, when, and what users should do." />
      </label>
      <label className={LABEL_CLASS}>
        Link (optional, a path on this site)
        <input className={`${INPUT_CLASS} mt-1`} name="link" maxLength={500} placeholder="/prices" pattern="/[a-zA-Z0-9].*" title="A path on this site, such as /prices" />
      </label>
      <label className={LABEL_CLASS}>
        Audience
        <select className={`${INPUT_CLASS} mt-1`} name="minPlan" defaultValue="free">
          {plans.map((plan) => (
            <option key={plan.key} value={plan.key}>
              {plan.key === 'free' ? 'Everyone' : `${plan.label} plan and above`}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL_CLASS}>
        Expires at (UTC, optional)
        <input className={`${INPUT_CLASS} mt-1`} name="expiresAt" type="datetime-local" />
      </label>
      <label className="flex items-center gap-2 self-end text-sm text-zinc-300">
        <input type="checkbox" name="important" className="h-4 w-4" />
        Important: also show as a banner on every dashboard page until read
      </label>
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={BUTTON_CLASS}>{pending ? 'Sending…' : 'Send announcement'}</button>
        {state.status !== 'idle' && (
          <p role={state.status === 'error' ? 'alert' : 'status'} className={`mt-3 text-sm ${state.status === 'error' ? 'text-rose-400' : 'text-emerald-300'}`}>
            {state.message}
          </p>
        )}
      </div>
    </form>
  );
}
