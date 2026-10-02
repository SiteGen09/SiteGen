'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { ATTACHMENT_ACCEPT, BODY_MAX, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '@/lib/support/types';

/** A customer follow-up with optional files, posted as multipart. */
export function ReplyForm({ ticketId, closed }: { ticketId: string; closed: boolean }) {
  const router = useRouter();
  const picker = useRef<HTMLInputElement>(null);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

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
    if (sending || !body.trim()) return;
    setSending(true);
    setError(null);
    const form = new FormData();
    form.set('body', body);
    for (const file of files) form.append('files', file);
    try {
      const response = await fetch(`/api/support/tickets/${ticketId}/messages`, { method: 'POST', body: form });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(payload?.error?.message ?? 'Your message could not be sent. Please try again.');
        return;
      }
      setBody('');
      setFiles([]);
      router.refresh();
    } catch {
      setError('Your message could not be sent. Check your connection and try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="rounded-xl border border-zinc-200 bg-white p-4">
      <label htmlFor="support-reply" className="block text-sm font-medium text-zinc-800">
        {closed ? 'Reply to reopen this request' : 'Add a reply'}
      </label>
      <textarea
        id="support-reply"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        maxLength={BODY_MAX}
        rows={4}
        required
        className="mt-1.5 block w-full resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-zinc-500 focus:ring-2 focus:ring-zinc-100"
      />
      {files.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {files.map((file, index) => (
            <li key={`${file.name}-${index}`} className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1 text-xs text-zinc-700">
              <span className="max-w-48 truncate">{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles(files.filter((_, position) => position !== index))}
                className="text-zinc-500 hover:text-zinc-900"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
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
          className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 disabled:opacity-40"
        >
          Add attachment
        </button>
        <button
          type="submit"
          disabled={sending || !body.trim()}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:opacity-85 disabled:opacity-40"
        >
          {sending ? 'Sending…' : 'Send reply'}
        </button>
      </div>
    </form>
  );
}
