'use client';

import { useActionState, useEffect, useState, type ChangeEvent } from 'react';

import {
  BUTTON_CLASS,
  BUTTON_SUBTLE_CLASS,
  IDLE_ACTION,
  INPUT_CLASS,
  LABEL_CLASS,
  type ActionState,
} from '../../_components/action-state';
import { isProvider, PROVIDERS, PROVIDER_LABELS, requiresBaseUrl } from '@/lib/ai/providers';
import {
  addCredentialAction,
  rotateCredentialAction,
  testCredentialAction,
} from '../actions';


/**
 * Which button was pressed last. Both buttons live in one form so the test
 * probes exactly the values about to be saved, but that means two independent
 * `useActionState` results — without this, a stale success from one would sit
 * under a fresh failure from the other. The click always precedes its
 * dispatch, so this stays in step with the result being rendered.
 */
type Mode = 'commit' | 'test';

interface Fields {
  provider: string;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

/**
 * Holds the form's values in React state rather than the DOM.
 *
 * React resets an uncontrolled `<form>` once any function action settles,
 * including a rejected probe — so a failed validation wiped the key, base URL
 * and model that had just been typed, which made finding a working
 * combination by trial and error impossible. Controlled inputs survive a
 * probe; the secret is dropped only once the server has stored it.
 */
function useCredentialFields(initial: Pick<Fields, 'provider' | 'baseUrl'>) {
  const [fields, setFields] = useState<Fields>({
    provider: initial.provider,
    baseUrl: initial.baseUrl,
    modelId: '',
    apiKey: '',
  });

  function bind(key: keyof Fields) {
    return {
      value: fields[key],
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { value } = event.target;
        setFields((prev) => ({ ...prev, [key]: value }));
      },
    };
  }

  /** Drops the secret from client memory once the server holds it encrypted. */
  function clearSecret() {
    setFields((prev) => ({ ...prev, apiKey: '' }));
  }

  return { fields, bind, clearSecret };
}

/** A compatible gateway is addressed by base URL; the first party is not. */
function needsBaseUrl(provider: string): boolean {
  return isProvider(provider) && requiresBaseUrl(provider);
}

/** Clears the key after a stored credential, but never after a failed probe. */
function useClearSecretOnSuccess(state: ActionState, clearSecret: () => void) {
  const stored = state.status === 'success';
  useEffect(() => {
    if (stored) clearSecret();
    // Keyed on the outcome, not on `clearSecret`, which is a fresh closure
    // every render and would otherwise re-run this on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, stored]);
}

function StateMessage({ state }: { state: ActionState }) {
  if (state.status === 'idle') return null;
  return (
    <span
      aria-live="polite"
      className={`text-sm ${state.status === 'error' ? 'text-rose-400' : 'text-emerald-400'}`}
    >
      {state.message}
    </span>
  );
}

/**
 * Test button. Read-only: it spends a few tokens on a live round trip and
 * stores nothing, so it is safe to press repeatedly while hunting for the
 * right provider/base-URL/model combination.
 */
function TestButton({ action, pending, onPress }: {
  action: (formData: FormData) => void;
  pending: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="submit"
      formAction={action}
      onClick={onPress}
      disabled={pending}
      className={BUTTON_SUBTLE_CLASS}
    >
      {pending ? 'Testing…' : 'Test connection'}
    </button>
  );
}

export function AddCredentialForm() {
  const [addState, addAction, addPending] = useActionState(addCredentialAction, IDLE_ACTION);
  const [testState, testAction, testPending] = useActionState(testCredentialAction, IDLE_ACTION);
  const [mode, setMode] = useState<Mode>('commit');
  const { fields, bind, clearSecret } = useCredentialFields({
    provider: 'anthropic',
    baseUrl: '',
  });
  useClearSecretOnSuccess(addState, clearSecret);

  const pending = addPending || testPending;
  const gateway = needsBaseUrl(fields.provider);

  return (
    <form action={addAction} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL_CLASS}>Provider</span>
          <select name="provider" {...bind('provider')} className={`${INPUT_CLASS} mt-1`}>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={LABEL_CLASS}>
            Validation model id {gateway ? '(required)' : '(optional)'}
          </span>
          <input
            name="modelId"
            {...bind('modelId')}
            placeholder="claude-3-5-haiku-20241022"
            className={`${INPUT_CLASS} mt-1`}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className={LABEL_CLASS}>
            Base URL{' '}
            {gateway
              ? '(required — one credential per gateway)'
              : '(fixed: anthropic always calls api.anthropic.com)'}
          </span>
          <input
            name="baseUrl"
            {...bind('baseUrl')}
            /* Disabled, not merely ignored: the first-party kind has a fixed
               host, and an editable field there invites a gateway URL that
               validation can only reject after a live probe. */
            disabled={!gateway}
            required={gateway}
            placeholder={gateway ? 'https://api.kie.ai/v1' : 'https://api.anthropic.com/v1'}
            className={`${INPUT_CLASS} mt-1 disabled:cursor-not-allowed disabled:opacity-50`}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className={LABEL_CLASS}>API key (validated live, then encrypted — never stored in plaintext)</span>
          <input
            name="apiKey"
            {...bind('apiKey')}
            type="password"
            autoComplete="off"
            required
            className={`${INPUT_CLASS} mt-1 font-mono`}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          onClick={() => setMode('commit')}
          disabled={pending}
          className={BUTTON_CLASS}
        >
          {addPending ? 'Validating…' : 'Validate & add'}
        </button>
        <TestButton action={testAction} pending={pending} onPress={() => setMode('test')} />
        <StateMessage state={mode === 'test' ? testState : addState} />
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
  const [rotateState, rotateAction, rotatePending] = useActionState(
    rotateCredentialAction,
    IDLE_ACTION,
  );
  const [testState, testAction, testPending] = useActionState(testCredentialAction, IDLE_ACTION);
  const [mode, setMode] = useState<Mode>('commit');
  const { bind, clearSecret } = useCredentialFields({ provider, baseUrl });
  useClearSecretOnSuccess(rotateState, clearSecret);

  const pending = rotatePending || testPending;
  const gateway = needsBaseUrl(provider);

  return (
    <form action={rotateAction} className="space-y-3">
      <input type="hidden" name="oldId" value={credentialId} />
      <input type="hidden" name="provider" value={provider} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL_CLASS}>
            Base URL {gateway ? '(required)' : '(not used by anthropic)'}
          </span>
          <input
            name="baseUrl"
            {...bind('baseUrl')}
            placeholder="https://…"
            className={`${INPUT_CLASS} mt-1`}
          />
        </label>
        <label className="block">
          <span className={LABEL_CLASS}>Validation model id</span>
          <input
            name="modelId"
            {...bind('modelId')}
            placeholder="claude-3-5-haiku-20241022"
            className={`${INPUT_CLASS} mt-1`}
          />
        </label>
        <label className="block sm:col-span-2">
          <span className={LABEL_CLASS}>New API key</span>
          <input
            name="apiKey"
            {...bind('apiKey')}
            type="password"
            autoComplete="off"
            required
            className={`${INPUT_CLASS} mt-1 font-mono`}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          onClick={() => setMode('commit')}
          disabled={pending}
          className={BUTTON_SUBTLE_CLASS}
        >
          {rotatePending ? 'Validating…' : 'Rotate'}
        </button>
        <TestButton action={testAction} pending={pending} onPress={() => setMode('test')} />
        <StateMessage state={mode === 'test' ? testState : rotateState} />
      </div>
    </form>
  );
}
