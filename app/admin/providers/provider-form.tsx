'use client';

import { useActionState, useState } from 'react';
import {
  isProviderReprice,
  uniformMultiplier,
  type ProviderPricing,
} from '@/lib/admin/provider-pricing';
import {
  BUTTON_CLASS,
  BUTTON_SUBTLE_CLASS,
  IDLE_ACTION,
  INPUT_CLASS,
  LABEL_CLASS,
} from '../_components/action-state';
import {
  releaseProviderPricingAction,
  saveProviderAction,
  setDefaultProviderAction,
} from './actions';

function times(value: string | number): string {
  return '×' + Number(value).toFixed(2);
}

export function ProviderForm({ provider }: { provider: ProviderPricing }) {
  const [state, action, pending] = useActionState(saveProviderAction, IDLE_ACTION);
  const [released, release, releasing] = useActionState(releaseProviderPricingAction, IDLE_ACTION);
  const uniform = uniformMultiplier(provider);
  const initial = provider.managedMultiplier ?? (uniform === null ? '' : uniform.toFixed(2));
  const [multiplier, setMultiplier] = useState(initial);
  const entered = multiplier.trim() === '' ? null : Math.round(Number(multiplier) * 100) / 100;
  const repricing = entered !== null && Number.isFinite(entered) && isProviderReprice(provider, entered);
  const sources = provider.sourceIds.length;
  const name = provider.label ?? provider.defaultLabel;
  const current =
    provider.minMultiplier === null
      ? 'No sources yet'
      : uniform !== null
        ? `${times(uniform)} on all ${sources} ${sources === 1 ? 'source' : 'sources'}`
        : `Mixed ${times(provider.minMultiplier)}–${times(provider.maxMultiplier!)} across ${sources} sources`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-zinc-50">
          {name}
          {provider.isDefault && (
            <span className="ml-2 rounded bg-indigo-500/15 px-2 py-0.5 text-xs font-normal text-indigo-300">
              Default
            </span>
          )}
        </h2>
        <span className="text-xs text-zinc-500">
          {provider.id} · {provider.modelCount} {provider.modelCount === 1 ? 'model' : 'models'} ·{' '}
          {current}
          {provider.managedMultiplier !== null && ' · provider-wide'}
        </span>
      </div>
      <form action={action} className="space-y-4">
        <input type="hidden" name="id" value={provider.id} />
        <input type="hidden" name="fingerprint" value={provider.fingerprint} />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={LABEL_CLASS}>
            Public name
            <input
              className={INPUT_CLASS}
              name="label"
              defaultValue={provider.label ?? ''}
              placeholder={provider.defaultLabel}
              maxLength={60}
            />
            <span className="mt-1 block font-normal text-zinc-500">
              Leave empty to use “{provider.defaultLabel}”.
            </span>
          </label>
          <label className={LABEL_CLASS}>
            Price multiplier
            <input
              className={INPUT_CLASS}
              name="creditMultiplier"
              type="number"
              min="0.01"
              step="0.01"
              value={multiplier}
              placeholder={uniform === null ? 'Mixed — enter one value' : undefined}
              onChange={(e) => setMultiplier(e.target.value)}
            />
            <span className="mt-1 block font-normal text-zinc-500">
              Applies to all {sources} {sources === 1 ? 'source' : 'sources'} and to sources added
              later.
            </span>
          </label>
        </div>
        {repricing && (
          <label className="block rounded border border-amber-700 p-3 text-sm text-amber-300">
            <input
              key={provider.fingerprint + ':' + multiplier}
              type="checkbox"
              name="confirmReprice"
              required
            />{' '}
            Reprice all {sources} {sources === 1 ? 'source' : 'sources'} ({provider.modelCount}{' '}
            {provider.modelCount === 1 ? 'model' : 'models'}) of {name}
            {uniform !== null ? ` from ${times(uniform)}` : ''} to {times(entered!)} on their next
            request. New sources for this provider also start at {times(entered!)}.
          </label>
        )}
        <button className={BUTTON_CLASS} disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {state.status !== 'idle' && (
          <p role="status" className="text-sm">
            {state.message}
          </p>
        )}
      </form>
      {provider.managedMultiplier !== null && (
        <form action={release} className="border-t border-zinc-800 pt-3">
          <input type="hidden" name="id" value={provider.id} />
          <button className={BUTTON_SUBTLE_CLASS} disabled={releasing}>
            Price sources individually
          </button>
          <span className="ml-3 text-xs text-zinc-500">
            Keeps today’s prices; sources stop following {times(provider.managedMultiplier)}.
          </span>
        </form>
      )}
      {/* Outside the form: a successful release removes it. */}
      {released.status !== 'idle' && (
        <p role="status" className="text-sm">
          {released.message}
        </p>
      )}
    </div>
  );
}

export function DefaultProviderForm({ providers }: { providers: ProviderPricing[] }) {
  const [state, action, pending] = useActionState(setDefaultProviderAction, IDLE_ACTION);
  const current = providers.find((provider) => provider.isDefault)?.id ?? '';
  return (
    <form action={action} className="space-y-3">
      <label className={LABEL_CLASS}>
        Default provider
        <select key={current} name="id" defaultValue={current} className={INPUT_CLASS + ' mt-1'}>
          <option value="">None — use each source’s Default flag</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label ?? provider.defaultLabel} ({provider.id})
            </option>
          ))}
        </select>
        <span className="mt-1 block font-normal text-zinc-500">
          Auto starts every chat, image and video request on this provider when it serves the
          model, then falls back to the others. A user’s own routing choice still wins.
        </span>
      </label>
      <button className={BUTTON_CLASS} disabled={pending}>
        {pending ? 'Saving…' : 'Save default'}
      </button>
      {state.status !== 'idle' && (
        <p role="status" className="text-sm">
          {state.message}
        </p>
      )}
    </form>
  );
}
