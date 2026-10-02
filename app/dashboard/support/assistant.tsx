'use client';

import { useEffect, useRef, useState } from 'react';

import { CHAT_MESSAGE_MAX, type SupportChatTurn } from '@/lib/support/types';
import { useContactSupport } from './contact-support';
import { RichText } from './rich-text';

const SUGGESTIONS = [
  'How do I set up Codex on Windows?',
  "A new model doesn't show up in Codex",
  'I get a 401 error in Claude Code',
  'How do I add credits?',
];

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : TIME.format(date);
}

/** Summary for a ticket opened from this conversation. */
function handoverBody(turns: readonly SupportChatTurn[]): string {
  const lastQuestion = [...turns].reverse().find((turn) => turn.role === 'user');
  return lastQuestion
    ? `I asked the setup assistant: "${lastQuestion.content.slice(0, 500)}" but it did not solve my problem.\n\n`
    : '';
}

export function SupportAssistant({
  initialSessionId,
  initialTurns,
}: {
  initialSessionId: string | null;
  initialTurns: SupportChatTurn[];
}) {
  const contact = useContactSupport();
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [turns, setTurns] = useState(initialTurns);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [turns, pending]);

  async function ask(content: string) {
    const question = content.trim();
    if (!question || pending !== null) return;
    setError(null);
    setPending(question);
    setDraft('');
    try {
      const response = await fetch('/api/support/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: question, sessionId }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { sessionId?: string; question?: SupportChatTurn; answer?: SupportChatTurn; error?: { message?: string } }
        | null;
      if (!response.ok || !payload?.question || !payload.answer || !payload.sessionId) {
        setError(payload?.error?.message ?? 'The assistant could not answer. Please try again.');
        setDraft(question);
        return;
      }
      setSessionId(payload.sessionId);
      setTurns((current) => [...current, payload.question!, payload.answer!]);
    } catch {
      setError('Could not reach the assistant. Check your connection and try again.');
      setDraft(question);
    } finally {
      setPending(null);
      textarea.current?.focus();
    }
  }

  function startOver() {
    setSessionId(null);
    setTurns([]);
    setError(null);
    textarea.current?.focus();
  }

  const empty = turns.length === 0 && pending === null;

  return (
    <section aria-label="Setup assistant" className="flex h-[min(72vh,44rem)] min-h-[28rem] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      <header className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-emerald-50 text-sm text-emerald-700">✦</span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900">Setup assistant</h2>
            <p className="truncate text-xs text-zinc-500">Instant answers about setup, keys, models and errors. Free to use.</p>
          </div>
        </div>
        {turns.length > 0 && (
          <button
            type="button"
            onClick={startOver}
            disabled={pending !== null}
            className="shrink-0 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
          >
            New conversation
          </button>
        )}
      </header>

      <div ref={scroller} className="flex-1 space-y-5 overflow-y-auto px-4 py-5" aria-live="polite">
        {empty && (
          <div className="mx-auto max-w-md py-6 text-center">
            <p className="text-base font-semibold text-zinc-900">How can we help you get set up?</p>
            <p className="mt-2 text-sm leading-6 text-zinc-500">
              Ask about connecting Codex, Claude Code, Cursor or another app, or paste an error message.
            </p>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void ask(suggestion)}
                  className="rounded-xl border border-zinc-200 px-3 py-2.5 text-left text-sm text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn) =>
          turn.role === 'user' ? (
            <div key={turn.id} className="flex flex-col items-end">
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-zinc-100 px-4 py-2.5 text-sm leading-6 text-zinc-900">
                <p className="whitespace-pre-wrap break-words">{turn.content}</p>
              </div>
              <span className="mt-1 text-[11px] text-zinc-400">{clock(turn.createdAt)}</span>
            </div>
          ) : (
            <div key={turn.id} className="max-w-[92%] text-zinc-800">
              <RichText text={turn.content} />
              <span className="mt-1 block text-[11px] text-zinc-400">{clock(turn.createdAt)}</span>
            </div>
          ),
        )}

        {pending !== null && (
          <>
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-zinc-100 px-4 py-2.5 text-sm leading-6 text-zinc-900">
                <p className="whitespace-pre-wrap break-words">{pending}</p>
              </div>
            </div>
            <p role="status" className="flex items-center gap-2 text-sm text-zinc-500">
              <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-emerald-600" />
              Thinking…
            </p>
          </>
        )}

        {turns.length > 0 && pending === null && (
          <p className="text-xs text-zinc-500">
            Still stuck?{' '}
            <button
              type="button"
              onClick={() =>
                contact({ category: 'setup', chatSessionId: sessionId, body: handoverBody(turns) })
              }
              className="font-medium text-zinc-800 underline hover:text-zinc-950"
            >
              Contact a person
            </button>{' '}
            and we will pick up from this conversation.
          </p>
        )}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
        className="border-t border-zinc-200 p-3"
      >
        {error && (
          <p role="alert" className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="rounded-xl border border-zinc-300 bg-white transition focus-within:border-zinc-400 focus-within:ring-2 focus-within:ring-zinc-100">
          <textarea
            ref={textarea}
            aria-label="Describe the setup problem"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                if (!event.repeat) event.currentTarget.form?.requestSubmit();
              }
            }}
            maxLength={CHAT_MESSAGE_MAX}
            rows={2}
            placeholder="Describe the setup problem"
            className="block max-h-40 min-h-14 w-full resize-none border-0 bg-transparent px-3 py-2.5 text-sm leading-6 text-zinc-900 outline-none placeholder:text-zinc-500"
          />
          <div className="flex items-center justify-between gap-3 px-3 pb-2">
            <span className="text-[11px] text-zinc-500">AI answers can be wrong. Never paste your API key.</span>
            <button
              type="submit"
              disabled={!draft.trim() || pending !== null}
              className="flex h-9 items-center gap-2 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white transition hover:opacity-85 disabled:opacity-35"
            >
              Send
              <span aria-hidden="true">↑</span>
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
