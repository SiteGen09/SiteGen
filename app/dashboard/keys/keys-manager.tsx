'use client';

import Link from 'next/link';
import { useActionState, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  createApiKey,
  revokeApiKey,
  setApiKeyEnabled,
  updateApiKey,
  type CreateKeyState,
  type RevokeKeyState,
  type UpdateKeyState,
} from '@/lib/actions/keys';
import { formatTimestamp } from '../ui';

/**
 * The keys page. Only server actions are imported, so no server-only module
 * (crypto, service client, env) is reachable from here, and every id the page
 * holds for routing is a public alias.
 */

export interface KeyView {
  id: string;
  name: string;
  masked: string;
  status: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  rateLimitRpm: number;
  quotaUsd: number | null;
  usedUsd: number;
  allowedModels: string[] | null;
  allowedIps: string[] | null;
  /** Public provider id; '' follows the owner's routing, 'unavailable' is a stale choice. */
  routingProvider: string;
  /** `family:modality` → public source id. */
  routingSources: Record<string, string>;
}

export interface ModelGroup {
  label: string;
  models: string[];
}

interface RoutingPair {
  key: string;
  modality: string;
  label: string;
  sources: { id: string; label: string; description: string; multiplier: string }[];
}

export interface RoutingChoices {
  providers: { publicId: string; label: string }[];
  pairs: RoutingPair[];
}

interface Endpoint {
  label: string;
  url: string;
}

type DisplayStatus = 'active' | 'disabled' | 'expired' | 'exhausted' | 'revoked';

const STATUS_LABELS: Record<DisplayStatus, string> = {
  active: 'Enabled',
  disabled: 'Disabled',
  expired: 'Expired',
  exhausted: 'Quota used',
  revoked: 'Revoked',
};

const STATUS_STYLES: Record<DisplayStatus, string> = {
  active: 'bg-emerald-50 text-emerald-700',
  disabled: 'bg-zinc-100 text-zinc-600',
  expired: 'bg-amber-50 text-amber-800',
  exhausted: 'bg-amber-50 text-amber-800',
  revoked: 'bg-red-50 text-red-700',
};

const PAGE_SIZE = 20;

function displayStatus(key: KeyView, now: number): DisplayStatus {
  if (key.status === 'revoked') return 'revoked';
  if (key.status === 'disabled') return 'disabled';
  if (key.expiresAt !== null && Date.parse(key.expiresAt) <= now) return 'expired';
  if (key.quotaUsd !== null && key.usedUsd >= key.quotaUsd) return 'exhausted';
  return 'active';
}

function usd(value: number): string {
  return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 });
}

/** A USD figure for an input box: no float noise, no trailing zeros. */
function usdInput(value: number): string {
  return String(Number(value.toFixed(4)));
}

const fieldClass =
  'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500 disabled:opacity-50';
const inputClass = `w-full ${fieldClass}`;
const buttonClass =
  'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50';
const primaryButtonClass =
  'rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50';

export function KeysManager({
  keys,
  endpoints,
  modelGroups,
  routing,
}: {
  keys: KeyView[];
  endpoints: Endpoint[];
  modelGroups: ModelGroup[];
  routing: RoutingChoices;
}) {
  const [editing, setEditing] = useState<{ mode: 'create' } | { mode: 'edit'; key: KeyView } | null>(null);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [nameFilter, setNameFilter] = useState('');
  const [keyFilter, setKeyFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'' | DisplayStatus>('');
  const [page, setPage] = useState(1);
  const [now] = useState(() => Date.now());

  const filtered = useMemo(() => keys.filter((key) =>
    key.name.toLowerCase().includes(nameFilter.trim().toLowerCase()) &&
    key.masked.toLowerCase().replace('…', '').includes(keyFilter.trim().toLowerCase().replace(/\*+|…/g, '')) &&
    (statusFilter === '' || displayStatus(key, now) === statusFilter),
  ), [keys, nameFilter, keyFilter, statusFilter, now]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        {endpoints.map((endpoint) => (
          <div key={endpoint.url} className="flex min-w-0 items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{endpoint.label}</p>
              <p className="truncate font-mono text-sm text-zinc-900">{endpoint.url}</p>
            </div>
            <CopyButton text={endpoint.url} label={`Copy ${endpoint.label} base URL`} />
          </div>
        ))}
      </div>

      {created !== null && (
        <NewKeyBanner name={created.name} apiKey={created.key} endpoints={endpoints} onDismiss={() => setCreated(null)} />
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={nameFilter}
          onChange={(event) => { setNameFilter(event.target.value); setPage(1); }}
          placeholder="Filter by name…"
          aria-label="Filter by name"
          className={`${fieldClass} w-full sm:w-56`}
        />
        <input
          type="search"
          value={keyFilter}
          onChange={(event) => { setKeyFilter(event.target.value); setPage(1); }}
          placeholder="Filter by API key…"
          aria-label="Filter by API key"
          className={`${fieldClass} w-full sm:w-56`}
        />
        <select
          value={statusFilter}
          onChange={(event) => { setStatusFilter(event.target.value as '' | DisplayStatus); setPage(1); }}
          aria-label="Filter by status"
          className={fieldClass}
        >
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABELS) as DisplayStatus[]).map((status) => (
            <option key={status} value={status}>{STATUS_LABELS[status]}</option>
          ))}
        </select>
        <button type="button" onClick={() => setEditing({ mode: 'create' })} className={`${primaryButtonClass} ml-auto`}>
          + Create API key
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full min-w-[72rem] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50">
              {['Name', 'Status', 'API key', 'Quota', 'Models', 'IP restriction', 'Created', 'Last used', 'Expires', ''].map((cell) => (
                <th key={cell} scope="col" className="whitespace-nowrap px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-sm text-zinc-500">
                  {keys.length === 0 ? 'No keys yet. Create one to start calling the API.' : 'No keys match these filters.'}
                </td>
              </tr>
            ) : (
              visible.map((key) => (
                <KeyRow key={key.id} apiKey={key} now={now} endpoints={endpoints} onEdit={() => setEditing({ mode: 'edit', key })} />
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-zinc-500">
        <span className="tabular-nums">
          {filtered.length} of {keys.length} {keys.length === 1 ? 'key' : 'keys'}
        </span>
        {pages > 1 && (
          <span className="flex items-center gap-2">
            <button type="button" className={buttonClass} disabled={current <= 1} onClick={() => setPage(current - 1)}>Previous</button>
            <span className="tabular-nums">Page {current} / {pages}</span>
            <button type="button" className={buttonClass} disabled={current >= pages} onClick={() => setPage(current + 1)}>Next</button>
          </span>
        )}
      </div>

      {editing !== null && (
        <KeyEditor
          key={editing.mode === 'edit' ? editing.key.id : 'create'}
          apiKey={editing.mode === 'edit' ? editing.key : null}
          modelGroups={modelGroups}
          routing={routing}
          onClose={() => setEditing(null)}
          onCreated={(name, key) => { setCreated({ name, key }); setEditing(null); }}
        />
      )}
    </>
  );
}

function KeyRow({
  apiKey,
  now,
  endpoints,
  onEdit,
}: {
  apiKey: KeyView;
  now: number;
  endpoints: Endpoint[];
  onEdit: () => void;
}) {
  const status = displayStatus(apiKey, now);
  const revoked = status === 'revoked';
  const expired = apiKey.expiresAt !== null && Date.parse(apiKey.expiresAt) <= now;
  const muted = 'whitespace-nowrap px-4 py-3 text-zinc-600';

  return (
    <tr className={revoked ? 'opacity-60' : undefined}>
      <td className="max-w-[14rem] truncate px-4 py-3 font-medium text-zinc-900" title={apiKey.name}>{apiKey.name}</td>
      <td className="whitespace-nowrap px-4 py-3">
        <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>{STATUS_LABELS[status]}</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-zinc-600">{apiKey.masked}</td>
      <td className="whitespace-nowrap px-4 py-3">
        <QuotaCell quotaUsd={apiKey.quotaUsd} usedUsd={apiKey.usedUsd} />
      </td>
      <td className={muted}>
        {apiKey.allowedModels === null ? (
          'All models'
        ) : (
          <span title={apiKey.allowedModels.join('\n')}>
            {apiKey.allowedModels.length === 1 ? apiKey.allowedModels[0] : `${apiKey.allowedModels.length} models`}
          </span>
        )}
      </td>
      <td className={muted}>
        {apiKey.allowedIps === null ? (
          'No restriction'
        ) : (
          <span title={apiKey.allowedIps.join('\n')} className="font-mono text-xs">
            {apiKey.allowedIps[0]}
            {apiKey.allowedIps.length > 1 && <span className="ml-1 font-sans text-zinc-500">+{apiKey.allowedIps.length - 1}</span>}
          </span>
        )}
      </td>
      <td className={`${muted} text-xs`}>{formatTimestamp(apiKey.createdAt)}</td>
      <td className={`${muted} text-xs`}>{formatTimestamp(apiKey.lastUsedAt)}</td>
      <td className={`${muted} text-xs ${expired && !revoked ? 'text-red-700' : ''}`}>
        {apiKey.expiresAt === null ? 'Never' : formatTimestamp(apiKey.expiresAt)}
      </td>
      <td className="whitespace-nowrap px-4 py-3">
        {!revoked && (
          <div className="flex items-center justify-end gap-1">
            <ToggleKey id={apiKey.id} enabled={apiKey.status === 'active'} />
            <IconButton label={`Edit ${apiKey.name}`} onClick={onEdit}><EditIcon /></IconButton>
            <MoreMenu apiKey={apiKey} endpoints={endpoints} onEdit={onEdit} />
          </div>
        )}
      </td>
    </tr>
  );
}

function QuotaCell({ quotaUsd, usedUsd }: { quotaUsd: number | null; usedUsd: number }) {
  if (quotaUsd === null) {
    return (
      <span className="text-zinc-600" title={`Used ${usd(usedUsd)}`}>
        Unlimited
      </span>
    );
  }
  const remaining = Math.max(0, quotaUsd - usedUsd);
  const share = quotaUsd === 0 ? 0 : remaining / quotaUsd;
  return (
    <div className="w-40" title={`Used ${usd(usedUsd)} of ${usd(quotaUsd)}`}>
      <div className="flex items-baseline justify-between gap-2 tabular-nums">
        <span className="font-semibold text-zinc-900">{usd(remaining)}</span>
        <span className="text-xs text-zinc-500">{usd(quotaUsd)}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-100" role="meter" aria-valuemin={0} aria-valuemax={quotaUsd} aria-valuenow={remaining} aria-label="Remaining quota">
        <div
          className={`h-full rounded-full ${share > 0.2 ? 'bg-emerald-500' : share > 0 ? 'bg-amber-500' : 'bg-red-500'}`}
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
    </div>
  );
}

function ToggleKey({ id, enabled }: { id: string; enabled: boolean }) {
  const [state, action, pending] = useActionState<RevokeKeyState, FormData>(setApiKeyEnabled, { status: 'idle' });
  return (
    <form action={action} className="relative">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <IconButton
        type="submit"
        disabled={pending}
        label={enabled ? 'Disable key' : 'Enable key'}
        className={enabled ? 'text-red-700' : 'text-emerald-700'}
      >
        <PowerIcon />
      </IconButton>
      {state.status === 'error' && (
        <p role="alert" className="absolute right-0 top-full z-10 mt-1 w-56 rounded bg-red-50 px-2 py-1 text-xs text-red-700">
          {state.message}
        </p>
      )}
    </form>
  );
}

function MoreMenu({ apiKey, endpoints, onEdit }: { apiKey: KeyView; endpoints: Endpoint[]; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [state, action, pending] = useActionState<RevokeKeyState, FormData>(revokeApiKey, { status: 'idle' });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  async function copyConnection() {
    const text = [
      ...endpoints.map((endpoint) => `${endpoint.label} base URL: ${endpoint.url}`),
      `API key: the full key for “${apiKey.name}” (${apiKey.masked}) that you saved when it was created`,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const itemClass = 'flex w-full items-center justify-between gap-4 rounded px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100';
  return (
    <div ref={ref} className="relative">
      <IconButton label={`More actions for ${apiKey.name}`} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <MoreIcon />
      </IconButton>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg">
          <button type="button" role="menuitem" className={itemClass} onClick={() => { setOpen(false); onEdit(); }}>
            Edit settings
          </button>
          <button type="button" role="menuitem" className={itemClass} onClick={copyConnection}>
            {copied ? 'Copied' : 'Copy connection info'}
          </button>
          <Link role="menuitem" href="/setup" className={itemClass}>
            Set up Codex / Claude Code
          </Link>
          <div className="my-1 border-t border-zinc-200" />
          <form
            action={action}
            onSubmit={(event) => {
              if (!window.confirm(`Revoke “${apiKey.name}”? Requests using it will stop working, and this cannot be undone.`)) event.preventDefault();
            }}
          >
            <input type="hidden" name="id" value={apiKey.id} />
            <button type="submit" role="menuitem" disabled={pending} className={`${itemClass} text-red-700 hover:bg-red-50`}>
              {pending ? 'Revoking…' : 'Revoke key'}
            </button>
          </form>
          {state.status === 'error' && <p role="alert" className="px-3 py-1 text-xs text-red-700">{state.message}</p>}
        </div>
      )}
    </div>
  );
}

function NewKeyBanner({
  name,
  apiKey,
  endpoints,
  onDismiss,
}: {
  name: string;
  apiKey: string;
  endpoints: Endpoint[];
  onDismiss: () => void;
}) {
  const connection = [...endpoints.map((endpoint) => `${endpoint.label} base URL: ${endpoint.url}`), `API key: ${apiKey}`].join('\n');
  return (
    <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-amber-900">
          Key “{name}” created. Copy it now — it is never shown again.
        </p>
        <button type="button" onClick={onDismiss} className="text-xs font-medium text-amber-900 underline">
          Dismiss
        </button>
      </div>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 overflow-x-auto rounded border border-amber-200 bg-white px-2.5 py-2 font-mono text-xs text-zinc-900">
          {apiKey}
        </code>
        <CopyButton text={apiKey} label="Copy key" showLabel />
        <CopyButton text={connection} label="Copy connection info" showLabel />
      </div>
      <p className="mt-2 text-xs text-amber-900">
        Using Codex or Claude Code? <Link href="/setup" className="underline">Set them up in one step</Link>.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- editor

function KeyEditor({
  apiKey,
  modelGroups,
  routing,
  onClose,
  onCreated,
}: {
  apiKey: KeyView | null;
  modelGroups: ModelGroup[];
  routing: RoutingChoices;
  onClose: () => void;
  onCreated: (name: string, key: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className="fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-xl overflow-hidden border-l border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-black/50"
    >
      {apiKey === null ? (
        <CreateForm titleId={titleId} modelGroups={modelGroups} routing={routing} onClose={onClose} onCreated={onCreated} />
      ) : (
        <EditForm titleId={titleId} apiKey={apiKey} modelGroups={modelGroups} routing={routing} onClose={onClose} />
      )}
    </dialog>
  );
}

function CreateForm({
  titleId,
  modelGroups,
  routing,
  onClose,
  onCreated,
}: {
  titleId: string;
  modelGroups: ModelGroup[];
  routing: RoutingChoices;
  onClose: () => void;
  onCreated: (name: string, key: string) => void;
}) {
  const [state, action, pending] = useActionState<CreateKeyState, FormData>(createApiKey, { status: 'idle' });
  useEffect(() => {
    if (state.status === 'created') onCreated(state.name, state.key);
  }, [state, onCreated]);
  return (
    <EditorShell
      titleId={titleId}
      title="Create API key"
      subtitle="Name the key and choose what it may do. Everything except the key itself can be changed later."
      action={action}
      pending={pending}
      submitLabel={pending ? 'Creating…' : 'Create key'}
      error={state.status === 'error' ? state.message : null}
      onClose={onClose}
    >
      <KeyFields apiKey={null} modelGroups={modelGroups} routing={routing} />
    </EditorShell>
  );
}

function EditForm({
  titleId,
  apiKey,
  modelGroups,
  routing,
  onClose,
}: {
  titleId: string;
  apiKey: KeyView;
  modelGroups: ModelGroup[];
  routing: RoutingChoices;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState<UpdateKeyState, FormData>(updateApiKey, { status: 'idle' });
  useEffect(() => {
    if (state.status === 'saved') onClose();
  }, [state, onClose]);
  return (
    <EditorShell
      titleId={titleId}
      title="Update API key"
      subtitle={`${apiKey.masked} · ${apiKey.rateLimitRpm} requests/min on your plan`}
      action={action}
      pending={pending}
      submitLabel={pending ? 'Saving…' : 'Save changes'}
      error={state.status === 'error' ? state.message : null}
      onClose={onClose}
    >
      <input type="hidden" name="id" value={apiKey.id} />
      <KeyFields apiKey={apiKey} modelGroups={modelGroups} routing={routing} />
    </EditorShell>
  );
}

function EditorShell({
  titleId,
  title,
  subtitle,
  action,
  pending,
  submitLabel,
  error,
  onClose,
  children,
}: {
  titleId: string;
  title: string;
  subtitle: string;
  action: (formData: FormData) => void;
  pending: boolean;
  submitLabel: string;
  error: string | null;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <form action={action} className="flex h-full flex-col">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-zinc-200 px-5 py-4">
        <div>
          <h2 id={titleId} className="text-base font-semibold text-zinc-900">{title}</h2>
          <p className="mt-0.5 text-sm text-zinc-500">{subtitle}</p>
        </div>
        <IconButton label="Close" onClick={onClose}><CloseIcon /></IconButton>
      </header>
      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">{children}</div>
      <footer className="shrink-0 border-t border-zinc-200 px-5 py-3">
        {error !== null && (
          <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass}>Close</button>
          <button type="submit" disabled={pending} className={primaryButtonClass}>{submitLabel}</button>
        </div>
      </footer>
    </form>
  );
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
        <p className="text-xs text-zinc-500">{hint}</p>
      </div>
      {children}
    </section>
  );
}

/** `datetime-local` value (local time, minute precision) for a timestamp. */
function localInputValue(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const EXPIRY_PRESETS = [
  { label: '1 hour', ms: 3_600_000 },
  { label: '1 day', ms: 86_400_000 },
  { label: '30 days', ms: 30 * 86_400_000 },
  { label: '1 year', ms: 365 * 86_400_000 },
] as const;

function KeyFields({
  apiKey,
  modelGroups,
  routing,
}: {
  apiKey: KeyView | null;
  modelGroups: ModelGroup[];
  routing: RoutingChoices;
}) {
  const ids = useId();
  const [expires, setExpires] = useState(() => (apiKey?.expiresAt ? localInputValue(Date.parse(apiKey.expiresAt)) : ''));
  const [unlimited, setUnlimited] = useState(apiKey === null || apiKey.quotaUsd === null);
  const expiresIso = expires === '' || Number.isNaN(new Date(expires).getTime()) ? '' : new Date(expires).toISOString();

  return (
    <>
      <Section title="Basic information" hint="How the key is named and how long it works.">
        <label className="block text-sm font-medium text-zinc-700" htmlFor={`${ids}-name`}>
          Name
        </label>
        <input
          id={`${ids}-name`}
          name="name"
          required
          maxLength={64}
          defaultValue={apiKey?.name ?? ''}
          placeholder="production"
          className={inputClass}
        />
        <div>
          <label className="block text-sm font-medium text-zinc-700" htmlFor={`${ids}-expires`}>
            Expiration time
          </label>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <input
              id={`${ids}-expires`}
              type="datetime-local"
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
              className={`${fieldClass} min-w-0 flex-1`}
            />
            <input type="hidden" name="expiresAt" value={expiresIso} />
            <button type="button" className={buttonClass} onClick={() => setExpires('')}>Never</button>
            {EXPIRY_PRESETS.map((preset) => (
              <button key={preset.label} type="button" className={buttonClass} onClick={() => setExpires(localInputValue(Date.now() + preset.ms))}>
                {preset.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-zinc-500">{expires === '' ? 'Never expires.' : 'Stops working at this time (your local time).'}</p>
        </div>
      </Section>

      <Section title="Quota" hint="The most this key may spend. Your account balance still applies.">
        <label className="flex items-center justify-between gap-4 rounded-md border border-zinc-200 px-3 py-2.5">
          <span>
            <span className="block text-sm font-medium text-zinc-900">Unlimited quota</span>
            <span className="block text-xs text-zinc-500">Only your account balance limits this key.</span>
          </span>
          <input
            type="checkbox"
            name="unlimited"
            checked={unlimited}
            onChange={(event) => setUnlimited(event.target.checked)}
            className="peer sr-only"
          />
          <span aria-hidden className="relative h-5 w-9 shrink-0 rounded-full bg-zinc-300 transition-colors peer-checked:bg-zinc-900 peer-focus-visible:ring-2 peer-focus-visible:ring-zinc-500 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" />
        </label>
        {!unlimited && (
          <div>
            <label className="block text-sm font-medium text-zinc-700" htmlFor={`${ids}-quota`}>
              Quota (USD)
            </label>
            <div className="relative mt-1.5">
              <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-zinc-500">$</span>
              <input
                id={`${ids}-quota`}
                name="quotaUsd"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                required
                defaultValue={apiKey?.quotaUsd != null ? usdInput(apiKey.quotaUsd) : ''}
                placeholder="10.00"
                className={`${inputClass} pl-7`}
              />
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              {apiKey === null
                ? 'Total this key may spend. The request that crosses the limit completes; later ones are refused.'
                : `Used so far: ${usd(apiKey.usedUsd)}. Set the total this key may spend, including what it has used.`}
            </p>
          </div>
        )}
      </Section>

      <ModelsField saved={apiKey?.allowedModels ?? null} groups={modelGroups} />

      <Section title="IP restriction" hint="Only accept requests from these addresses. Leave empty to allow any.">
        <textarea
          name="ips"
          rows={3}
          defaultValue={apiKey?.allowedIps?.join('\n') ?? ''}
          placeholder={'203.0.113.7\n198.51.100.0/24\n2001:db8::/32'}
          aria-label="Allowed IP addresses"
          className={`${inputClass} font-mono`}
        />
        <p className="text-xs text-zinc-500">One IP address or CIDR range per line, up to 100.</p>
      </Section>

      <RoutingField apiKey={apiKey} routing={routing} />
    </>
  );
}

function ModelsField({ saved, groups }: { saved: string[] | null; groups: ModelGroup[] }) {
  const [mode, setMode] = useState<'all' | 'selected'>(saved === null ? 'all' : 'selected');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(saved ?? []));
  const [query, setQuery] = useState('');
  const known = new Set(groups.flatMap((group) => group.models));
  // A saved model that is not offered any more stays listed, so saving does not silently drop it.
  const allGroups = [...groups, ...(saved?.some((model) => !known.has(model)) ? [{ label: 'No longer offered', models: saved.filter((model) => !known.has(model)) }] : [])];
  const needle = query.trim().toLowerCase();
  const shown = allGroups
    .map((group) => ({ ...group, models: group.models.filter((model) => model.toLowerCase().includes(needle)) }))
    .filter((group) => group.models.length > 0);

  function toggle(model: string, on: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(model);
      else next.delete(model);
      return next;
    });
  }

  return (
    <Section title="Models" hint="Which models this key may call.">
      <input type="hidden" name="modelsMode" value={mode} />
      {mode === 'selected' && [...selected].map((model) => <input key={model} type="hidden" name="models" value={model} />)}
      <div className="flex gap-2" role="radiogroup" aria-label="Model access">
        {(['all', 'selected'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            onClick={() => setMode(value)}
            className={mode === value ? primaryButtonClass : buttonClass}
          >
            {value === 'all' ? 'All models' : 'Only selected models'}
          </button>
        ))}
      </div>
      {mode === 'selected' && (
        <div className="rounded-md border border-zinc-200">
          <div className="flex items-center gap-2 border-b border-zinc-200 p-2">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models…"
              aria-label="Search models"
              className={`${inputClass} py-1.5`}
            />
            <button
              type="button"
              className="shrink-0 text-xs font-medium text-zinc-600 underline"
              onClick={() => setSelected((previous) => new Set([...previous, ...shown.flatMap((group) => group.models)]))}
            >
              Select shown
            </button>
            <button type="button" className="shrink-0 text-xs font-medium text-zinc-600 underline" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto p-2">
            {shown.length === 0 && <p className="px-2 py-3 text-sm text-zinc-500">No models match.</p>}
            {shown.map((group) => (
              <fieldset key={group.label} className="mb-2">
                <legend className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{group.label}</legend>
                {group.models.map((model) => (
                  <label key={model} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-zinc-800 hover:bg-zinc-50">
                    <input type="checkbox" checked={selected.has(model)} onChange={(event) => toggle(model, event.target.checked)} />
                    <span className="truncate font-mono text-xs">{model}</span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
          <p className="border-t border-zinc-200 px-3 py-2 text-xs text-zinc-500">{selected.size} selected</p>
        </div>
      )}
    </Section>
  );
}

function RoutingField({ apiKey, routing }: { apiKey: KeyView | null; routing: RoutingChoices }) {
  const chat = routing.pairs.filter((pair) => pair.modality === 'chat');
  const media = routing.pairs.filter((pair) => pair.modality !== 'chat');
  const provider = apiKey?.routingProvider ?? '';
  const mediaOverridden = media.some((pair) => apiKey?.routingSources[pair.key]);

  return (
    <Section title="Routing" hint="Override your account’s routing for requests made with this key. “Use my routing” follows the Routing page.">
      <div>
        <label className="block text-sm font-medium text-zinc-700">
          Default provider
          <select name="routingProvider" defaultValue={provider} className={`${inputClass} mt-1.5`}>
            <option value="">Use my routing</option>
            {provider === 'unavailable' && <option value="unavailable" disabled>Saved provider unavailable — choose another</option>}
            {routing.providers.map((item) => (
              <option key={item.publicId} value={item.publicId}>{item.label}</option>
            ))}
          </select>
        </label>
        <p className="mt-1 text-xs text-zinc-500">Auto starts on this provider for every model it serves, then falls back as usual.</p>
      </div>
      {chat.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {chat.map((pair) => <PairSelect key={pair.key} pair={pair} saved={apiKey?.routingSources[pair.key] ?? ''} />)}
        </div>
      )}
      {media.length > 0 && (
        <details open={mediaOverridden} className="rounded-md border border-zinc-200">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-zinc-700">Image and video sources</summary>
          <div className="grid gap-3 border-t border-zinc-200 p-3 sm:grid-cols-2">
            {media.map((pair) => <PairSelect key={pair.key} pair={pair} saved={apiKey?.routingSources[pair.key] ?? ''} />)}
          </div>
        </details>
      )}
    </Section>
  );
}

function PairSelect({ pair, saved }: { pair: RoutingPair; saved: string }) {
  const [choice, setChoice] = useState(saved);
  const source = pair.sources.find((item) => item.id === choice);
  return (
    <label className="block text-sm font-medium text-zinc-700">
      {pair.label}
      <select
        name={`route:${pair.key}`}
        value={choice}
        onChange={(event) => setChoice(event.target.value)}
        className={`${inputClass} mt-1.5`}
      >
        <option value="">Use my routing</option>
        {choice !== '' && source === undefined && <option value={choice} disabled>Saved source unavailable — choose another</option>}
        {pair.sources.map((item) => (
          <option key={item.id} value={item.id}>{item.label} · ×{item.multiplier}</option>
        ))}
      </select>
      {source?.description && <span className="mt-1 block text-xs font-normal leading-5 text-zinc-500">{source.description}</span>}
    </label>
  );
}

// ---------------------------------------------------------------- small parts

function CopyButton({ text, label, showLabel = false }: { text: string; label: string; showLabel?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  if (showLabel) {
    return (
      <button type="button" onClick={copy} className="shrink-0 rounded-md border border-amber-300 bg-white px-2.5 py-2 text-xs font-medium text-amber-900 hover:bg-amber-100">
        {copied ? 'Copied' : label}
      </button>
    );
  }
  return (
    <IconButton label={copied ? 'Copied' : label} onClick={copy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </IconButton>
  );
}

function IconButton({
  label,
  children,
  className = 'text-zinc-600',
  type = 'button',
  ...rest
}: {
  label: string;
  children: ReactNode;
  className?: string;
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
  'aria-expanded'?: boolean;
}) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-zinc-100 disabled:opacity-50 ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

const CopyIcon = () => <Icon><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></Icon>;
const CheckIcon = () => <Icon><path d="M20 6 9 17l-5-5" /></Icon>;
const EditIcon = () => <Icon><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></Icon>;
const PowerIcon = () => <Icon><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.8 0" /></Icon>;
const MoreIcon = () => <Icon><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></Icon>;
const CloseIcon = () => <Icon><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>;
