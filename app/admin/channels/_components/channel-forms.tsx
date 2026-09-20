'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';

import {
  BUTTON_CLASS,
  IDLE_ACTION,
  INPUT_CLASS,
  LABEL_CLASS,
  type ActionState,
} from '../../_components/action-state';
import { PROVIDERS, PROVIDER_LABELS } from '@/lib/ai/providers';
import { createChannelAction, updateChannelAction } from '../actions';

const TASK_OPTIONS = ['site.spec', 'site.copy', 'interview', 'chat.completions'] as const;
const STATUS_OPTIONS = ['active', 'degraded', 'off'] as const;

export interface ChannelDefaults {
  vendor: string;
  contextWindow: string;
  endpoints: string;
  tags: string;
  pricingType: string;
  listInputPerMTok: string;
  listOutputPerMTok: string;
  listCachedPerMTok: string;
  id: string;
  label: string;
  task: string;
  provider: string;
  baseUrl: string;
  modelId: string;
  publicModelId: string;
  sourceId: string;
  isByok: boolean;
  status: string;
  minPlan: string;
  fallbackTo: string;
  priority: string;
  inputPerMTok: string;
  outputPerMTok: string;
  cachedPerMTok: string;
}

interface FieldsProps {
  defaults: ChannelDefaults;
  planKeys: readonly string[];
  fallbackOptions: readonly string[];
  sourceOptions: readonly { id: string; label: string }[];
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

function ChannelFields({
  defaults,
  planKeys,
  fallbackOptions,
  sourceOptions,
  lockId,
}: FieldsProps) {
  const [pricingType, setPricingType] = useState(defaults.pricingType);
  const rateUnit = pricingType === 'request' ? '$/request' : '$/Mtok';
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
        <input
          name="label"
          defaultValue={defaults.label}
          required
          className={`${INPUT_CLASS} mt-1`}
        />
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
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Model id</span>
        <input
          name="modelId"
          defaultValue={defaults.modelId}
          required
          className={`${INPUT_CLASS} mt-1`}
        />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Base URL (required for every *_compatible provider)</span>
        <input
          name="baseUrl"
          defaultValue={defaults.baseUrl}
          placeholder="https://…"
          className={`${INPUT_CLASS} mt-1`}
        />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Public model id (gateway only)</span>
        <input
          name="publicModelId"
          defaultValue={defaults.publicModelId}
          placeholder="stub-chat"
          className={`${INPUT_CLASS} mt-1`}
        />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Input {rateUnit}</span>
        <input
          name="inputPerMTok"
          type="number"
          step="0.000001"
          min="0"
          defaultValue={defaults.inputPerMTok}
          required
          className={`${INPUT_CLASS} mt-1`}
        />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Output {rateUnit}</span>
        <input
          name="outputPerMTok"
          type="number"
          step="0.000001"
          min="0"
          defaultValue={defaults.outputPerMTok}
          required
          className={`${INPUT_CLASS} mt-1`}
        />
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Cached {rateUnit}</span>
        <input
          name="cachedPerMTok"
          type="number"
          step="0.000001"
          min="0"
          defaultValue={defaults.cachedPerMTok}
          required
          className={`${INPUT_CLASS} mt-1`}
        />
      </label>
      <label className={LABEL_CLASS}>
        <input type="checkbox" name="isByok" defaultChecked={defaults.isByok} /> BYOK only (choose
        no source)
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Source</span>
        <select name="sourceId" defaultValue={defaults.sourceId} className={INPUT_CLASS}>
          <option value="">— none (BYOK) —</option>
          {sourceOptions.map((source) => (
            <option key={source.id} value={source.id}>
              {source.label}
            </option>
          ))}
        </select>
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
      <label className={LABEL_CLASS}>
        Pricing type
        <select
          className={INPUT_CLASS}
          name="pricingType"
          value={pricingType}
          onChange={(event) => setPricingType(event.target.value)}
        >
          <option value="token">Token — rates in USD per million tokens</option>
          <option value="request">Request — rates in USD per request</option>
        </select>
      </label>
      {/* Vendor metadata is optional; blank list prices never imply a discount. */}
      {(
        [
          ['vendor', 'Display vendor (openai, anthropic, deepseek, xai, …)'],
          ['contextWindow', 'Context window (tokens)'],
          ['endpoints', 'Endpoints (comma separated)'],
          ['tags', 'Tags (comma separated)'],
          ['listInputPerMTok', 'Vendor list input price (USD)'],
          ['listOutputPerMTok', 'Vendor list output price (USD)'],
          ['listCachedPerMTok', 'Vendor list cached price (USD)'],
        ] as const
      ).map(([name, label]) => (
        <label key={name} className={LABEL_CLASS}>
          {label}
          <input className={INPUT_CLASS} name={name} defaultValue={defaults[name]} />
        </label>
      ))}
      <p className="text-xs text-zinc-400 sm:col-span-2">
        All rate fields use the selected pricing unit. Request rates are per call; token rates are
        per million tokens. Request-priced entries appear on Prices and are excluded from
        token-billed gateway routes.
      </p>
      <label className="block sm:col-span-2">
        <span className={LABEL_CLASS}>Fallback channel</span>
        <select
          name="fallbackTo"
          defaultValue={defaults.fallbackTo}
          className={`${INPUT_CLASS} mt-1`}
        >
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
  sourceOptions,
}: {
  planKeys: readonly string[];
  fallbackOptions: readonly string[];
  sourceOptions: readonly { id: string; label: string }[];
}) {
  const [state, action] = useActionState(createChannelAction, IDLE_ACTION);
  const empty: ChannelDefaults = {
    vendor: '',
    contextWindow: '',
    endpoints: '',
    tags: '',
    pricingType: 'token',
    listInputPerMTok: '',
    listOutputPerMTok: '',
    listCachedPerMTok: '',
    id: '',
    label: '',
    task: 'site.spec',
    provider: 'anthropic',
    baseUrl: '',
    modelId: '',
    publicModelId: '',
    sourceId: '',
    isByok: false,
    status: 'active',
    minPlan: 'free',
    fallbackTo: '',
    priority: '0',
    inputPerMTok: '0',
    outputPerMTok: '0',
    cachedPerMTok: '0',
  };
  return (
    <form action={action} className="space-y-4">
      <ChannelFields
        defaults={empty}
        planKeys={planKeys}
        fallbackOptions={fallbackOptions}
        sourceOptions={sourceOptions}
        lockId={false}
      />
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
  sourceOptions,
}: {
  defaults: ChannelDefaults;
  planKeys: readonly string[];
  fallbackOptions: readonly string[];
  sourceOptions: readonly { id: string; label: string }[];
}) {
  const [state, action] = useActionState(updateChannelAction, IDLE_ACTION);
  return (
    <form action={action} className="space-y-4">
      <ChannelFields
        defaults={defaults}
        planKeys={planKeys}
        fallbackOptions={fallbackOptions}
        sourceOptions={sourceOptions}
        lockId
      />
      <div className="flex items-center gap-4">
        <SubmitButton label="Save changes" />
        <StateMessage state={state} />
      </div>
    </form>
  );
}
