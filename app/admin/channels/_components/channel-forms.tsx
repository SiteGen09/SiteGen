'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import {
  BUTTON_CLASS,
  IDLE_ACTION,
  INPUT_CLASS,
  LABEL_CLASS,
  type ActionState,
} from '../../_components/action-state';
import { createChannelAction, updateChannelAction } from '../actions';

const TASK_OPTIONS = ['site.spec', 'site.copy', 'interview'] as const;
const PROVIDER_OPTIONS = ['anthropic', 'openai_compatible'] as const;
const STATUS_OPTIONS = ['active', 'degraded', 'off'] as const;

export interface ChannelDefaults {
  id: string;
  label: string;
  task: string;
  provider: string;
  baseUrl: string;
  modelId: string;
  creditMultiplier: string;
  status: string;
  minPlan: string;
  fallbackTo: string;
  priority: string;
}

interface FieldsProps {
  defaults: ChannelDefaults;
  planKeys: readonly string[];
  fallbackOptions: readonly string[];
  lockId: boolean;
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={BUTTON_CLASS} disabled={pending}>
      {pending ? 'Saving…' : label}
    </button>
  );
}

function StateMessage({ state }: { state: ActionState }) {
  if (state.status === 'idle') return null;
  return (
    <p
      className={`text-sm ${state.status === 'error' ? 'text-rose-400' : 'text-emerald-400'}`}
      role="status"
    >
      {state.message}
    </p>
  );
}

function ChannelFields({ defaults, planKeys, fallbackOptions, lockId }: FieldsProps) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="block">
        <span className={LABEL_CLASS}>Channel id (slug)</span>
        <input
          name="id"
          defaultValue={defaults.id}
          readOnly={lockId}
          required
          placeholder="spec-strong"
          className={`${INPUT_CLASS} mt-1 ${lockId ? 'opacity-60' : ''}`}
        />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Label</span>
        <input name="label" defaultValue={defaults.label} required className={`${INPUT_CLASS} mt-1`} />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Task</span>
        <select name="task" defaultValue={defaults.task} className={`${INPUT_CLASS} mt-1`}>
          {TASK_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Provider</span>
        <select name="provider" defaultValue={defaults.provider} className={`${INPUT_CLASS} mt-1`}>
          {PROVIDER_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Model id</span>
        <input name="modelId" defaultValue={defaults.modelId} required className={`${INPUT_CLASS} mt-1`} />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Base URL (openai_compatible only)</span>
        <input
          name="baseUrl"
          defaultValue={defaults.baseUrl}
          placeholder="https://…"
          className={`${INPUT_CLASS} mt-1`}
        />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Credit multiplier</span>
        <input
          name="creditMultiplier"
          type="number"
          step="0.01"
          min="0"
          defaultValue={defaults.creditMultiplier}
          required
          className={`${INPUT_CLASS} mt-1`}
        />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Priority</span>
        <input
          name="priority"
          type="number"
          step="1"
          defaultValue={defaults.priority}
          required
          className={`${INPUT_CLASS} mt-1`}
        />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Status</span>
        <select name="status" defaultValue={defaults.status} className={`${INPUT_CLASS} mt-1`}>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Minimum plan</span>
        <select name="minPlan" defaultValue={defaults.minPlan} className={`${INPUT_CLASS} mt-1`}>
          {planKeys.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="block sm:col-span-2">
        <span className={LABEL_CLASS}>Fallback channel</span>
        <select name="fallbackTo" defaultValue={defaults.fallbackTo} className={`${INPUT_CLASS} mt-1`}>
          <option value="">— none —</option>
          {fallbackOptions.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function CreateChannelForm({
  planKeys,
  fallbackOptions,
}: {
  planKeys: readonly string[];
  fallbackOptions: readonly string[];
}) {
  const [state, action] = useActionState(createChannelAction, IDLE_ACTION);
  const empty: ChannelDefaults = {
    id: '',
    label: '',
    task: 'site.spec',
    provider: 'anthropic',
    baseUrl: '',
    modelId: '',
    creditMultiplier: '1.00',
    status: 'active',
    minPlan: 'free',
    fallbackTo: '',
    priority: '0',
  };
  return (
    <form action={action} className="space-y-4">
      <ChannelFields defaults={empty} planKeys={planKeys} fallbackOptions={fallbackOptions} lockId={false} />
      <div className="flex items-center gap-4">
        <SubmitButton label="Create channel" />
        <StateMessage state={state} />
      </div>
    </form>
  );
}

export function EditChannelForm({
  defaults,
  planKeys,
  fallbackOptions,
}: {
  defaults: ChannelDefaults;
  planKeys: readonly string[];
  fallbackOptions: readonly string[];
}) {
  const [state, action] = useActionState(updateChannelAction, IDLE_ACTION);
  return (
    <form action={action} className="space-y-4">
      <ChannelFields defaults={defaults} planKeys={planKeys} fallbackOptions={fallbackOptions} lockId />
      <div className="flex items-center gap-4">
        <SubmitButton label="Save changes" />
        <StateMessage state={state} />
      </div>
    </form>
  );
}
