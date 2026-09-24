'use client';
import { useActionState } from 'react';
import { reviewDispute } from './actions';
import type { ActionState } from '../_components/action-state';
const initial: ActionState = {status:'idle'};
export function ReviewForm({ id }: {id:string}) {
  const [state,action,pending] = useActionState(reviewDispute,initial);
  return <form action={action} className="mt-3 space-y-2"><input type="hidden" name="id" value={id} />
    <label className="block text-xs">Review note<textarea required name="note" minLength={10} maxLength={1000} className="mt-1 block w-full rounded border border-zinc-700 bg-zinc-900 p-2" /></label>
    <button disabled={pending} className="rounded border border-zinc-600 p-2 text-xs disabled:opacity-50">{pending ? 'Saving…' : 'Approve release for this dispute'}</button>
    {state.status !== 'idle' && <p role={state.status === 'error' ? 'alert' : 'status'} className="text-xs">{state.message}</p>}
  </form>;
}
