'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';

import {
  BUTTON_CLASS,
  BUTTON_SUBTLE_CLASS,
  IDLE_ACTION,
  INPUT_CLASS,
  LABEL_CLASS,
  type ActionState,
} from '../../_components/action-state';
import { addCredentialAction, rotateCredentialAction } from '../actions';

const PROVIDER_OPTIONS = ['anthropic', 'openai_compatible'] as const;

function SubmitButton({ label, subtle }: { label: string; subtle?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={subtle === true ? BUTTON_SUBTLE_CLASS : BUTTON_CLASS}
      disabled={pending}
    >
      {pending ? 'Validating…' : label}
    </button>
  );
}

function StateMessage({ state }: { state: ActionState }) {
  if (state.status === 'idle') return null;
  return (
    <span className={`text-sm ${state.status === 'error' ? 'text-rose-400' : 'text-emerald-400'}`}>
      {state.message}
    </span>
  );
}

export function AddCredentialForm() {
  const [state, action] = useActionState(addCredentialAction, IDLE_ACTION);
  return (
    <form action={action} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL_CLASS}>Provider</span>
          <select name="provider" defaultValue="anthropic" className={`${INPUT_CLASS} mt-1`}>
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL_CLASS}>Validation model id (required for openai_compatible)</span>
          <input name="modelId" placeholder="claude-3-5-haiku-20241022" className={`${INPUT_CLASS} mt-1`} />
        </label>
        <label className="block sm:col-span-2">
          <span className={LABEL_CLASS}>Base URL (openai_compatible only)</span>
          <input name="baseUrl" placeholder="https://…" className={`${INPUT_CLASS} mt-1`} />
        </label>
        <label className="block sm:col-span-2">
          <span className={LABEL_CLASS}>API key (validated live, then encrypted — never stored in plaintext)</span>
          <input
            name="apiKey"
            type="password"
            autoComplete="off"
            required
            className={`${INPUT_CLASS} mt-1 font-mono`}
          />
        </label>
      </div>
      <div className="flex items-center gap-4">
        <SubmitButton label="Validate & add" />
        <StateMessage state={state} />
      </div>
    </form>
  );
}

export function RotateCredentialForm({
  credentialId,
  provider,
  baseUrl,
}: {
  credentialId: string;
  provider: string;
  baseUrl: string;
}) {
  const [state, action] = useActionState(rotateCredentialAction, IDLE_ACTION);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="oldId" value={credentialId} />
      <input type="hidden" name="provider" value={provider} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL_CLASS}>Base URL</span>
          <input name="baseUrl" defaultValue={baseUrl} placeholder="https://…" className={`${INPUT_CLASS} mt-1`} />
        </label>
        <label className="block">
          <span className={LABEL_CLASS}>Validation model id</span>
          <input name="modelId" placeholder="claude-3-5-haiku-20241022" className={`${INPUT_CLASS} mt-1`} />
        </label>
        <label className="block sm:col-span-2">
          <span className={LABEL_CLASS}>New API key</span>
          <input
            name="apiKey"
            type="password"
            autoComplete="off"
            required
            className={`${INPUT_CLASS} mt-1 font-mono`}
          />
        </label>
      </div>
      <div className="flex items-center gap-4">
        <SubmitButton label="Rotate" subtle />
        <StateMessage state={state} />
      </div>
    </form>
  );
}
