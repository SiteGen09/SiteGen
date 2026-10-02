'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import {
  ATTACHMENT_ACCEPT,
  BODY_MAX,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  SUBJECT_MAX,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  type TicketCategory,
} from '@/lib/support/types';

export interface ContactPrefill {
  subject?: string;
  category?: TicketCategory;
  body?: string;
  /** The assistant conversation to hand over to staff. */
  chatSessionId?: string | null;
}

const OpenContext = createContext<(prefill?: ContactPrefill) => void>(() => {});

/** Opens the Contact support dialog from anywhere under {@link SupportProvider}. */
export function useContactSupport(): (prefill?: ContactPrefill) => void {
  return useContext(OpenContext);
}

export function SupportProvider({ children }: { children: ReactNode }) {
  // Each opening gets a fresh form, keyed by this counter.
  const [opening, setOpening] = useState<{ count: number; prefill: ContactPrefill } | null>(null);
  const open = useCallback(
    (prefill: ContactPrefill = {}) => setOpening((current) => ({ count: (current?.count ?? 0) + 1, prefill })),
    [],
  );
  return (
    <OpenContext.Provider value={open}>
      {children}
      {opening && <ContactDialog key={opening.count} prefill={opening.prefill} onClose={() => setOpening(null)} />}
    </OpenContext.Provider>
  );
}

export function ContactSupportButton({ className, prefill }: { className?: string; prefill?: ContactPrefill }) {
  const open = useContactSupport();
  return (
    <button
      type="button"
      onClick={() => open(prefill)}
      className={`inline-flex min-h-9 items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 transition hover:bg-zinc-100 ${className ?? ''}`.trimEnd()}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="4" />
        <path d="m5.6 5.6 3.6 3.6m5.6 5.6 3.6 3.6m0-12.8-3.6 3.6m-5.6 5.6-3.6 3.6" />
      </svg>
      Contact support
    </button>
  );
}

function clientDiagnostics(): string {
  return JSON.stringify({
    userAgent: navigator.userAgent.slice(0, 400),
    page: window.location.pathname.slice(0, 400),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    screen: `${window.screen.width}x${window.screen.height}`,
  });
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const FIELD = 'mt-1.5 block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-500 focus:ring-2 focus:ring-zinc-100';
const LABEL = 'block text-sm font-medium text-zinc-800';

function ContactDialog({ prefill, onClose }: { prefill: ContactPrefill; onClose: () => void }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = [...files];
    for (const file of Array.from(list)) {
      if (next.length >= MAX_ATTACHMENTS) {
        setError(`Attach up to ${MAX_ATTACHMENTS} files.`);
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`${file.name} is larger than 4 MB.`);
        continue;
      }
      next.push(file);
    }
    setFiles(next);
    if (picker.current) picker.current.value = '';
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    setError(null);
    setSending(true);
    const form = new FormData(event.currentTarget);
    if (form.get('diagnostics') === 'on') form.set('clientDiagnostics', clientDiagnostics());
    if (prefill.chatSessionId) form.set('chatSessionId', prefill.chatSessionId);
    for (const file of files) form.append('files', file);
    try {
      const response = await fetch('/api/support/tickets', { method: 'POST', body: form });
      const payload = (await response.json().catch(() => null)) as
        | { id?: string; error?: { message?: string } }
        | null;
      if (!response.ok || !payload?.id) {
        setError(payload?.error?.message ?? 'Your request could not be sent. Please try again.');
        setSending(false);
        return;
      }
      dialog.current?.close();
      router.push(`/dashboard/support/${payload.id}?created=1`);
      router.refresh();
    } catch {
      setError('Your request could not be sent. Check your connection and try again.');
      setSending(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      aria-labelledby="contact-support-title"
      className="m-auto w-[calc(100%-2rem)] max-w-xl rounded-2xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-2xl backdrop:bg-black/50"
    >
      <form onSubmit={(event) => void submit(event)} className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-5">
          <div>
            <h2 id="contact-support-title" className="text-base font-semibold text-zinc-900">Contact support</h2>
            <p className="mt-0.5 text-sm text-zinc-500">Tell us what happened. We reply here, under Support.</p>
          </div>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            aria-label="Close"
            className="-mr-1 grid h-8 w-8 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          >
            <span aria-hidden="true" className="text-lg leading-none">×</span>
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-3">
          <label className={LABEL}>
            Subject
            <input name="subject" required minLength={3} maxLength={SUBJECT_MAX} defaultValue={prefill.subject ?? ''} autoFocus className={FIELD} />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className={LABEL}>
              Category
              <select name="category" defaultValue={prefill.category ?? 'setup'} className={FIELD}>
                {TICKET_CATEGORIES.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </select>
            </label>
            <label className={LABEL}>
              Priority
              <select name="priority" defaultValue="normal" className={FIELD}>
                {TICKET_PRIORITIES.map((entry) => (
                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                ))}
              </select>
            </label>
          </div>

          <label className={LABEL}>
            Message
            <textarea
              name="body"
              required
              minLength={10}
              maxLength={BODY_MAX}
              rows={5}
              defaultValue={prefill.body ?? ''}
              placeholder="What were you trying to do, what happened, and what did you expect?"
              className={`${FIELD} resize-y`}
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className={LABEL}>
              Request ID <span className="font-normal text-zinc-500">(optional)</span>
              <input name="requestId" maxLength={128} placeholder="From the error or Usage page" className={`${FIELD} font-mono text-xs`} />
            </label>
            <label className={LABEL}>
              Payment/order ID <span className="font-normal text-zinc-500">(optional)</span>
              <input name="orderId" maxLength={128} placeholder="From Billing history" className={`${FIELD} font-mono text-xs`} />
            </label>
          </div>

          {prefill.chatSessionId && (
            <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
              Your conversation with the setup assistant is attached, so you do not need to repeat it.
            </p>
          )}

          <label className="flex items-start gap-2.5 text-sm text-zinc-800">
            <input type="checkbox" name="diagnostics" defaultChecked className="mt-0.5 h-4 w-4 accent-emerald-700" />
            <span>
              Attach technical diagnostics
              <span className="block text-xs text-zinc-500">
                Your plan, balance, number of active keys, recent failed request IDs, browser and time zone. Never your API keys.
              </span>
            </span>
          </label>

          <div>
            <p className={LABEL}>Attachments</p>
            {files.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {files.map((file, index) => (
                  <li key={`${file.name}-${index}`} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm">
                    <span className="min-w-0 truncate text-zinc-800">{file.name}</span>
                    <span className="flex shrink-0 items-center gap-3 text-xs text-zinc-500">
                      {formatBytes(file.size)}
                      <button
                        type="button"
                        onClick={() => setFiles(files.filter((_, position) => position !== index))}
                        className="font-medium text-zinc-700 underline hover:text-zinc-900"
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <input
              ref={picker}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              onChange={(event) => addFiles(event.target.files)}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
            />
            <button
              type="button"
              disabled={files.length >= MAX_ATTACHMENTS}
              onClick={() => picker.current?.click()}
              className="mt-2 inline-flex min-h-9 items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-40"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.3-2.4l7.9-7.9" />
              </svg>
              Add attachment
            </button>
            <p className="mt-1.5 text-xs text-zinc-500">
              Up to {MAX_ATTACHMENTS} files, 4 MB each: screenshots, PDFs, logs or config files. Remove API keys from anything you attach.
            </p>
          </div>

          {error && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            className="rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={sending}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:opacity-85 disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send request'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
