'use client';

import { useActionState, useState } from 'react';
import type { Source } from '@/lib/ai/sources';
import { FAMILIES } from '@/lib/ai/source-types';
import { PLAN_KEYS } from '@/lib/billing/plans';
import { BUTTON_CLASS, IDLE_ACTION, INPUT_CLASS, LABEL_CLASS } from '../_components/action-state';
import { createSourceAction, updateSourceAction, deleteSourceAction } from './actions';

export function SourceForm({ source, count = 0 }: { source?: Source; count?: number }) {
  const [state, action, pending] = useActionState(
    source ? updateSourceAction : createSourceAction,
    IDLE_ACTION,
  );
  const [deletion, remove, deleting] = useActionState(deleteSourceAction, IDLE_ACTION);
  const [multiplier, setMultiplier] = useState(source?.credit_multiplier ?? '1.00');
  const repricing = source !== undefined && Number(multiplier) !== Number(source.credit_multiplier);
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={LABEL_CLASS}>
            Source id
            <input
              className={INPUT_CLASS}
              name="id"
              defaultValue={source?.id}
              readOnly={!!source}
              required
            />
          </label>
          <label className={LABEL_CLASS}>
            Label
            <input className={INPUT_CLASS} name="label" defaultValue={source?.label} required />
          </label>
          <label className={LABEL_CLASS}>
            Family
            {source && <input type="hidden" name="family" value={source.family} />}
            <select
              className={INPUT_CLASS}
              name="family"
              disabled={!!source}
              defaultValue={source?.family ?? 'gpt'}
            >
              {FAMILIES.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label className={LABEL_CLASS}>
            Credit multiplier
            <input
              className={INPUT_CLASS}
              name="creditMultiplier"
              type="number"
              min="0.01"
              step="0.01"
              value={multiplier}
              onChange={(e) => setMultiplier(e.target.value)}
              required
            />
          </label>
          <label className={LABEL_CLASS}>
            Status
            <select className={INPUT_CLASS} name="status" defaultValue={source?.status ?? 'active'}>
              {['active', 'degraded', 'off'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className={LABEL_CLASS}>
            Minimum plan
            <select
              className={INPUT_CLASS}
              name="minPlan"
              defaultValue={source?.min_plan ?? 'free'}
            >
              {PLAN_KEYS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label className={LABEL_CLASS + ' sm:col-span-2'}>
            Description
            <textarea
              className={INPUT_CLASS}
              name="description"
              defaultValue={source?.description ?? ''}
            />
          </label>
          <label className={LABEL_CLASS}>
            <input name="isDefault" type="checkbox" defaultChecked={source?.is_default} /> Default
            for this family
          </label>
        </div>
        <input type="hidden" name="affectedCount" value={count} />
        <input type="hidden" name="originalMultiplier" value={source?.credit_multiplier ?? ''} />
        {repricing && (
          <label className="block rounded border border-amber-700 p-3 text-sm text-amber-300">
            <input
              key={source.credit_multiplier + ':' + count + ':' + multiplier}
              type="checkbox"
              name="confirmReprice"
              required
            />{' '}
            Reprice all {count} {count === 1 ? 'channel' : 'channels'} from ×
            {source.credit_multiplier} to ×{multiplier} on their next request.
          </label>
        )}
        <button className={BUTTON_CLASS} disabled={pending}>
          {pending ? 'Saving…' : source ? 'Save source' : 'Create source'}
        </button>
        {state.status !== 'idle' && (
          <p role="status" className="text-sm">
            {state.message}
          </p>
        )}
      </form>
      {source && (
        <form action={remove}>
          <input type="hidden" name="id" value={source.id} />
          <button className="text-sm text-rose-400 underline" disabled={deleting}>
            Delete unused source
          </button>
          {deletion.status !== 'idle' && <p role="status">{deletion.message}</p>}
        </form>
      )}
    </div>
  );
}
