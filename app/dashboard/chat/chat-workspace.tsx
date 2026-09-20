'use client';

import { useRef, useState } from 'react';
import { z } from 'zod';
import {
  conversationSchema,
  savedMessageSchema,
  type Conversation,
  type SavedMessage,
} from '@/lib/chat/conversations';
import { readSseData } from '@/lib/chat/sse';
import { createClient } from '@/lib/supabase/client';

const frameSchema = z.object({
  error: z.object({ message: z.string() }).optional(),
  choices: z.array(z.object({ delta: z.object({ content: z.string().optional() }) })).optional(),
});

export function ChatWorkspace({
  models,
  initialConversations,
}: {
  models: string[];
  initialConversations: Conversation[];
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<SavedMessage[]>([]);
  const [model, setModel] = useState(models[0] ?? '');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loadVersion = useRef(0);

  async function openConversation(conversation: Conversation): Promise<void> {
    const version = ++loadVersion.current;
    setBusy(true);
    setError('');
    try {
      // Browser reads are RLS-scoped. Neither a guessed id nor another user's
      // link can return their messages through this query.
      const result = await createClient()
        .from('chat_messages')
        .select('id, role, content, model, tokens, created_at')
        .eq('conversation_id', conversation.id)
        .order('created_at')
        .order('id');
      if (result.error) throw new Error('Could not load conversation.');
      if (version !== loadVersion.current) return;
      setConversationId(conversation.id);
      setMessages(savedMessageSchema.array().parse(result.data));
      if (models.includes(conversation.model)) setModel(conversation.model);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load conversation.');
    } finally {
      if (version === loadVersion.current) setBusy(false);
    }
  }

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || !draft.trim() || !model) return;
    setBusy(true);
    setError('');
    const content = draft.trim();
    const assistantId = crypto.randomUUID();
    const now = new Date().toISOString();
    const previous = messages;
    setMessages([
      ...previous,
      { id: crypto.randomUUID(), role: 'user', content, model, tokens: null, created_at: now },
      { id: assistantId, role: 'assistant', content: '', model, tokens: null, created_at: now },
    ]);
    let accepted = false;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, model, content }),
      });
      if (!response.ok) {
        const body = frameSchema.safeParse(await response.json());
        throw new Error(
          body.success
            ? (body.data.error?.message ?? 'Could not send message.')
            : 'Could not send message.',
        );
      }
      accepted = true;
      setDraft('');
      const id = response.headers.get('x-conversation-id');
      if (id) setConversationId(id);
      if (!response.body) throw new Error('The response had no stream.');
      let done = false;
      for await (const data of readSseData(response.body)) {
        if (data === '[DONE]') {
          done = true;
          break;
        }
        const frame = frameSchema.parse(JSON.parse(data));
        if (frame.error) throw new Error(frame.error.message);
        const text = frame.choices?.[0]?.delta.content;
        if (text)
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, content: message.content + text }
                : message,
            ),
          );
      }
      if (!done)
        throw new Error(
          'The connection ended early. Reload the conversation to check the saved response.',
        );
    } catch (err) {
      if (!accepted) setMessages(previous);
      setError(err instanceof Error ? err.message : 'Could not send message.');
    } finally {
      const result = await createClient()
        .from('chat_conversations')
        .select('id, title, model, updated_at')
        .order('updated_at', { ascending: false })
        .limit(100);
      if (!result.error) setConversations(conversationSchema.array().parse(result.data));
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-[65vh] gap-4 lg:grid-cols-[15rem_1fr]">
      <aside className="rounded-lg border border-zinc-200 bg-white p-3">
        <button
          disabled={busy}
          onClick={() => {
            setConversationId(undefined);
            setMessages([]);
            setError('');
          }}
          className="mb-3 w-full rounded bg-zinc-900 p-2 text-sm text-white disabled:opacity-50"
        >
          New chat
        </button>
        <nav aria-label="Conversations" className="max-h-[55vh] space-y-1 overflow-y-auto">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              disabled={busy}
              onClick={() => void openConversation(conversation)}
              aria-current={conversationId === conversation.id ? 'page' : undefined}
              className={
                'block w-full truncate rounded p-2 text-left text-sm hover:bg-zinc-100 ' +
                (conversationId === conversation.id ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-600')
              }
            >
              {conversation.title}
            </button>
          ))}
        </nav>
      </aside>
      <section className="flex min-w-0 flex-col rounded-lg border border-zinc-200 bg-white p-4">
        <label className="text-sm text-zinc-600">
          Model
          <select
            value={model}
            disabled={busy}
            onChange={(e) => setModel(e.target.value)}
            className="ml-3 rounded border border-zinc-300 bg-white p-2 text-zinc-900"
          >
            {!models.length && <option value="">No models available</option>}
            {models.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <div
          role="log"
          aria-label="Messages"
          className="my-5 max-h-[55vh] flex-1 space-y-4 overflow-y-auto"
        >
          {!messages.length && (
            <p className="py-12 text-center text-zinc-500">
              Start a conversation. Completed replies are saved automatically.
            </p>
          )}
          {messages.map((message) => (
            <article
              key={message.id}
              className={
                'rounded-lg p-3 ' +
                (message.role === 'user' ? 'bg-zinc-100' : 'border border-zinc-200')
              }
            >
              <p className="mb-1 text-xs font-semibold uppercase text-zinc-500">
                {message.role === 'user' ? 'You' : message.model}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm text-zinc-900">
                {message.content || (busy ? 'Thinking…' : '')}
              </p>
            </article>
          ))}
        </div>
        {error && (
          <p role="alert" className="mb-3 text-sm text-red-700">
            {error}
          </p>
        )}
        <form onSubmit={(event) => void send(event)} className="flex gap-2">
          <textarea
            aria-label="Message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            maxLength={32000}
            rows={3}
            placeholder="Write a message…"
            className="min-w-0 flex-1 rounded border border-zinc-300 bg-white p-3 text-sm"
          />
          <button
            disabled={busy || !draft.trim() || !model}
            className="self-end rounded bg-zinc-900 px-4 py-3 text-sm text-white disabled:opacity-50"
          >
            {busy ? 'Answering…' : 'Send'}
          </button>
        </form>
      </section>
    </div>
  );
}
