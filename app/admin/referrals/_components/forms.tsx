'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import {
  BUTTON_SUBTLE_CLASS, IDLE_ACTION, INPUT_CLASS, LABEL_CLASS, type ActionState,
} from '../../_components/action-state';
import { recordReferralPayoutAction, updateReferralSettingsAction, updateReferrerAction } from '../actions';

function Submit({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" className={BUTTON_SUBTLE_CLASS} disabled={pending}>{pending ? busy : idle}</button>;
}

function Message({ state }: { state: ActionState }) {
  if (state.status === 'idle') return null;
  return <span role={state.status === 'error' ? 'alert' : 'status'} className={`text-xs ${state.status === 'error' ? 'text-rose-400' : 'text-emerald-400'}`}>{state.message}</span>;
}

const percent = (bps: number | null) => bps === null ? '' : String(bps / 100);

export function SettingsForm({ settings }: {
  settings: { enabled: boolean; commission_bps: number; bonus_bps: number; hold_days: number; window_days: number | null };
}) {
  const [state, action] = useActionState(updateReferralSettingsAction, IDLE_ACTION);
  return (
    <form action={action} className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-zinc-200">
        <input type="checkbox" name="enabled" defaultChecked={settings.enabled} /> Program enabled
      </label>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className={LABEL_CLASS}>Referrer reward (%)
          <input name="commission" inputMode="decimal" defaultValue={percent(settings.commission_bps)} required className={`${INPUT_CLASS} mt-1`} />
        </label>
        <label className={LABEL_CLASS}>New-user bonus on first top-up (%)
          <input name="bonus" inputMode="decimal" defaultValue={percent(settings.bonus_bps)} required className={`${INPUT_CLASS} mt-1`} />
        </label>
        <label className={LABEL_CLASS}>Hold before rewards unlock (days)
          <input name="hold_days" type="number" min="0" max="180" step="1" defaultValue={settings.hold_days} required className={`${INPUT_CLASS} mt-1`} />
        </label>
        <label className={LABEL_CLASS}>Earning window after signup (days)
          <input name="window_days" type="number" min="1" max="3650" step="1" defaultValue={settings.window_days ?? ''} placeholder="no limit" className={`${INPUT_CLASS} mt-1`} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3"><Submit idle="Save settings" busy="Saving…" /><Message state={state} /></div>
    </form>
  );
}

export function ReferrerForm({ userId, commissionBps, frozen, defaultBps }: {
  userId: string; commissionBps: number | null; frozen: boolean; defaultBps: number;
}) {
  const [state, action] = useActionState(updateReferrerAction, IDLE_ACTION);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="userId" value={userId} />
      <label className={LABEL_CLASS}>Reward rate override (%)
        <input name="commission" inputMode="decimal" defaultValue={percent(commissionBps)} placeholder={`default ${defaultBps / 100}`} className={`${INPUT_CLASS} mt-1 w-36`} />
      </label>
      <label className="flex items-center gap-2 pb-2 text-sm text-zinc-200">
        <input type="checkbox" name="frozen" defaultChecked={frozen} /> Freeze rewards
      </label>
      <Submit idle="Save" busy="Saving…" />
      <Message state={state} />
    </form>
  );
}

export function PayoutForm({ userId, available, reclaimable }: { userId: string; available: number; reclaimable: number }) {
  const [state, action] = useActionState(recordReferralPayoutAction, IDLE_ACTION);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="userId" value={userId} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={LABEL_CLASS}>Take credits from
          <select name="source" defaultValue="wallet" className={`${INPUT_CLASS} mt-1`}>
            <option value="wallet">Rewards wallet ({available.toLocaleString('en-US')} available)</option>
            <option value="balance">Balance, transferred rewards ({reclaimable.toLocaleString('en-US')} max)</option>
          </select>
        </label>
        <label className={LABEL_CLASS}>Credits to remove
          <input name="credits" type="number" min="1" step="1" required className={`${INPUT_CLASS} mt-1`} />
        </label>
        <label className={LABEL_CLASS}>Cash sent
          <input name="cash" inputMode="decimal" placeholder="12.50" required className={`${INPUT_CLASS} mt-1`} />
        </label>
        <label className={LABEL_CLASS}>Currency
          <input name="currency" defaultValue="USD" maxLength={3} required className={`${INPUT_CLASS} mt-1 uppercase`} />
        </label>
        <label className={LABEL_CLASS}>Method
          <input name="method" placeholder="PayPal, GCash, bank…" required className={`${INPUT_CLASS} mt-1`} />
        </label>
        <label className={LABEL_CLASS}>Reference / transaction ID
          <input name="reference" className={`${INPUT_CLASS} mt-1`} />
        </label>
        <label className={`${LABEL_CLASS} sm:col-span-2`}>Note (admins only)
          <input name="note" className={`${INPUT_CLASS} mt-1`} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3"><Submit idle="Record cash payout" busy="Recording…" /><Message state={state} /></div>
      <p className="text-xs text-zinc-500">Send the money yourself first. This only records it and removes the credits. The user sees a line reading &ldquo;Reward payout (processed by support)&rdquo;.</p>
    </form>
  );
}
