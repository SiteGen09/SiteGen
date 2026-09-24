'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { conversationSchema, savedMessageSchema, type Conversation, type SavedMessage } from '@/lib/chat/conversations';
import { ATTACHMENT_ACCEPT, attachmentsSchema, chooseModel, decodeTurn, detectMode, encodeTurn, readAttachment, supportsImages, supportsTextGeneration, type ChatAttachment, type ChatMode, type ComposerMode } from '@/lib/chat/composer';
import { readSseData } from '@/lib/chat/sse';
import { parseMediaMarker } from '@/lib/media/marker';
import { createClient } from '@/lib/supabase/client';
import { MediaBubble } from './media-bubble';
import { GenerationProgress } from './generation-progress';

const frameSchema = z.object({
  model: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
  choices: z.array(z.object({ delta: z.object({ content: z.string().optional() }) })).optional(),
});
const examples = [
  { label: 'Explore an idea', prompt: 'Help me brainstorm a memorable launch for a small coffee shop.', mode: 'chat' },
  { label: 'Create an image', prompt: 'Create an image of a cozy coffee shop on a rainy evening, warm cinematic lighting.', mode: 'image' },
  { label: 'Make a video', prompt: 'Generate a video of ocean waves at sunrise, with a slow cinematic camera movement.', mode: 'video' },
] as const;

function AttachmentCards({ files, onRemove }: { files: ChatAttachment[]; onRemove?: (index: number) => void }) {
  return <div className="flex flex-wrap gap-2">{files.map((file, index) => (
    <div key={index} className="flex max-w-full items-center gap-2 rounded-xl border border-zinc-200 bg-white p-2 text-xs">
      {file.kind === 'image' ? (
        // Data URLs are validated and bounded before entering the transcript.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={file.data} alt={file.name} className="h-12 w-12 rounded-lg object-cover" />
      ) : <span aria-hidden="true" className="grid h-10 w-10 place-items-center rounded-lg bg-zinc-100 text-zinc-600">TXT</span>}
      <span className="max-w-40 truncate text-zinc-700" title={file.name}>{file.name}</span>
      {onRemove && <button type="button" onClick={() => onRemove(index)} aria-label={'Remove ' + file.name} className="rounded-lg px-2 py-1 text-lg text-zinc-500 hover:bg-zinc-100">×</button>}
    </div>
  ))}</div>;
}

export function ChatWorkspace({ models, imageModels, videoModels, initialConversations }: {
  models: string[]; imageModels: string[]; videoModels: string[]; initialConversations: Conversation[];
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<SavedMessage[]>([]);
  const [mode, setMode] = useState<ComposerMode>('auto');
  const [model, setModel] = useState('auto');
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<{ message: string } | null>(null);
  const error = notice?.message ?? '';
  const setError = useCallback((message: string) => {
    // A new occurrence of the same warning gets its own seven seconds.
    setNotice(message ? { message } : null);
  }, []);
  const [pendingGeneration, setPendingGeneration] = useState<{ startedAt: string; kind: 'image' | 'video' } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const loadVersion = useRef(0);
  const sending = useRef(false);
  const readingFiles = useRef(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const modes: ComposerMode[] = ['auto', 'chat', ...(imageModels.length ? ['image' as const] : []), ...(videoModels.length ? ['video' as const] : [])];
  const visibleExamples = examples.filter((example) => example.mode === 'chat' || (example.mode === 'image' ? imageModels.length > 0 : videoModels.length > 0));

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const kind: ChatMode = mode === 'auto' ? detectMode(draft) : mode;
  const needsImages = attachments.some((file) => file.kind === 'image') || messages.some((message) => message.role === 'user' && decodeTurn(message.content).attachments.some((file) => file.kind === 'image'));
  const modeModels = kind === 'image' ? imageModels : kind === 'video' ? videoModels : models;
  const eligibleModels = kind !== 'chat' ? modeModels.filter(supportsTextGeneration) : needsImages ? modeModels.filter(supportsImages) : modeModels;
  const available = model !== 'auto' && eligibleModels.includes(model) ? model : chooseModel(modeModels, kind, kind === 'chat' && needsImages);
  const attachmentBlock = kind !== 'chat' && attachments.length > 0;
  const canSend = !busy && !reading && (draft.trim().length > 0 || attachments.length > 0) && !!available && !attachmentBlock;

  useEffect(() => {
    if (transcript.current && followLatest.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages]);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = 'auto';
    textarea.current.style.height = Math.min(textarea.current.scrollHeight, 180) + 'px';
  }, [draft]);

  async function refreshConversations(): Promise<void> {
    try {
      const result = await createClient().from('chat_conversations').select('id, title, model, updated_at').order('updated_at', { ascending: false }).limit(100);
      const parsed = conversationSchema.array().safeParse(result.data);
      if (!result.error && parsed.success) setConversations(parsed.data);
    } catch { /* A sidebar refresh must never strand the composer. */ }
  }

  async function addFiles(files: File[]): Promise<void> {
    if (busy || sending.current || readingFiles.current || !files.length) return;
    readingFiles.current = true;
    setReading(true);
    setError('');
    try {
      if (attachments.length + files.length > 3) throw new Error('Attach up to 3 files per message.');
      const added = await Promise.all(files.map(readAttachment));
      const parsed = attachmentsSchema.safeParse([...attachments, ...added]);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Could not attach these files.');
      setAttachments(parsed.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the attachment.');
    } finally {
      readingFiles.current = false;
      setReading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function openConversation(conversation: Conversation): Promise<void> {
    if (sending.current || readingFiles.current) return;
    const version = ++loadVersion.current;
    setBusy(true);
    setError('');
    try {
      const result = await createClient().from('chat_messages').select('id, role, content, model, tokens, created_at').eq('conversation_id', conversation.id).order('created_at').order('id');
      if (result.error) throw new Error('Could not load conversation.');
      if (version !== loadVersion.current) return;
      setConversationId(conversation.id);
      followLatest.current = true;
      setMessages(savedMessageSchema.array().parse(result.data));
      setAttachments([]);
      setDraft('');
      setMode('auto');
      setModel('auto');
      setHistoryOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load conversation.');
    } finally {
      if (version === loadVersion.current) setBusy(false);
    }
  }

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSend || sending.current || readingFiles.current) return;
    const content = draft.trim();
    if (kind !== 'chat' && content.length > 5000) { setError('Image and video prompts can be up to 5,000 characters.'); return; }
    sending.current = true;
    setBusy(true);
    setError('');
    followLatest.current = true;
    const previous = messages;
    const assistantId = crypto.randomUUID();
    const now = new Date().toISOString();
    const userTurn: SavedMessage = { id: crypto.randomUUID(), role: 'user', content: encodeTurn(content, attachments), model: available, tokens: null, created_at: now };
    let accepted = false;
    try {
      if (kind !== 'chat') {
        setPendingGeneration({ startedAt: now, kind });
        const response = await fetch('/api/media', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId, kind, model: available, prompt: content }) });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error?.message ?? 'Could not start the render.');
        const id = response.headers.get('x-conversation-id') ?? body.conversation_id;
        if (id) setConversationId(id);
        setMessages([...previous, userTurn, { id: assistantId, role: 'assistant', content: '[[media:' + body.id + ']]', model: available, tokens: null, created_at: now }]);
        setDraft('');
        setAttachments([]);
        return;
      }
      setMessages([...previous, userTurn, { id: assistantId, role: 'assistant', content: '', model: available, tokens: null, created_at: now }]);
      const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId, model: available, content, attachments }) });
      if (!response.ok) {
        const body = frameSchema.safeParse(await response.json());
        throw new Error(body.success ? (body.data.error?.message ?? 'Could not send message.') : 'Could not send message.');
      }
      accepted = true;
      setDraft('');
      setAttachments([]);
      const id = response.headers.get('x-conversation-id');
      if (id) setConversationId(id);
      if (!response.body) throw new Error('The response had no stream.');
      let done = false;
      for await (const data of readSseData(response.body)) {
        if (data === '[DONE]') { done = true; break; }
        const frame = frameSchema.parse(JSON.parse(data));
        if (frame.error) throw new Error(frame.error.message);
        if (frame.model) setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, model: frame.model! } : message));
        const text = frame.choices?.[0]?.delta.content;
        if (text) setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: message.content + text } : message));
      }
      if (!done) throw new Error('The connection ended early. Reload the conversation to check the saved response.');
    } catch (err) {
      if (!accepted) setMessages(previous);
      setError(err instanceof Error ? err.message : 'Could not send message.');
    } finally {
      setPendingGeneration(null);
      await refreshConversations();
      sending.current = false;
      setBusy(false);
      requestAnimationFrame(() => textarea.current?.focus());
    }
  }

  function newChat() {
    if (sending.current || readingFiles.current) return;
    ++loadVersion.current;
    setConversationId(undefined); setMessages([]); setAttachments([]); setDraft(''); setError(''); setMode('auto'); setModel('auto'); setHistoryOpen(false);
    textarea.current?.focus();
  }

  function hasDraggedFiles(event: React.DragEvent): boolean {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function enterDropArea(event: React.DragEvent): void {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function leaveDropArea(event: React.DragEvent): void {
    if (!hasDraggedFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function dropFiles(event: React.DragEvent): void {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (busy || sending.current || readingFiles.current) {
      setError('Wait for the current response or file to finish, then drop your files again.');
      return;
    }
    void addFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <div className="grid min-h-[70vh] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm lg:grid-cols-[15rem_1fr]">
      <aside className={(historyOpen ? 'block ' : 'hidden ') + 'border-b border-zinc-200 bg-zinc-50 p-4 lg:block lg:border-r lg:border-b-0'}>
        <button disabled={busy || reading} onClick={newChat} className="mb-6 flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:opacity-85 disabled:opacity-50"><span aria-hidden="true">＋</span> New chat</button>
        <p className="mb-3 px-2 text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">Your conversations</p>
        <nav aria-label="Conversations" className="max-h-[56vh] space-y-1 overflow-y-auto">
          {!conversations.length && <p className="px-2 py-4 text-xs leading-6 text-zinc-500">Your conversations will appear here. Pick up where you left off anytime.</p>}
          {conversations.map((conversation) => <button key={conversation.id} disabled={busy || reading} onClick={() => void openConversation(conversation)} aria-current={conversationId === conversation.id ? 'page' : undefined} className={'block w-full truncate rounded-xl px-3 py-2.5 text-left text-sm transition hover:bg-zinc-100 ' + (conversationId === conversation.id ? 'bg-white font-medium text-zinc-900 shadow-sm' : 'text-zinc-600')} title={conversation.title}>{conversation.title}</button>)}
        </nav>
      </aside>
      <section
        className="relative flex min-w-0 flex-col"
        aria-label="Chat workspace"
        onDragEnter={enterDropArea}
        onDragLeave={leaveDropArea}
        onDragOver={(event) => {
          if (!hasDraggedFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = busy || reading ? 'none' : 'copy';
        }}
        onDrop={dropFiles}
        onDragEnd={() => { dragDepth.current = 0; setDragging(false); }}
      >
        {dragging && <div role="status" className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-zinc-500 bg-white/95 p-6 text-center">
          <div><span aria-hidden="true" className="text-4xl text-zinc-500">＋</span><p className="mt-3 text-lg font-semibold text-zinc-900">{busy || reading ? 'Please wait before adding files' : 'Drop files to attach'}</p><p className="mt-2 text-sm text-zinc-500">Images and text files · Up to 3 files, 2 MB total</p></div>
        </div>}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3"><span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-xl bg-zinc-900 text-lg text-white">✦</span><div><p className="text-sm font-semibold text-zinc-900">Your creative workspace</p><p className="text-xs text-zinc-500">One conversation. More possibilities.</p></div></div>
          <div className="flex gap-2"><button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)} className="rounded-lg border border-zinc-200 px-3 py-2 text-xs lg:hidden">History</button><button type="button" disabled={busy || reading} onClick={newChat} className="rounded-lg border border-zinc-200 px-3 py-2 text-xs lg:hidden">New chat</button><span className="hidden rounded-full bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700 sm:block">Saved automatically</span></div>
        </header>
        <div ref={transcript} role="log" aria-label="Messages" aria-live="polite" onScroll={(event) => { const node = event.currentTarget; followLatest.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }} className="max-h-[58vh] min-h-72 flex-1 space-y-6 overflow-y-auto px-4 py-6 sm:px-8">
          {!messages.length && <div className="mx-auto max-w-xl py-6 text-center sm:py-10"><span aria-hidden="true" className="mb-4 inline-grid h-14 w-14 place-items-center rounded-2xl border border-zinc-200 bg-zinc-50 text-3xl text-zinc-800">✦</span><h2 className="text-2xl font-semibold tracking-tight text-zinc-900 sm:text-3xl">What would you like to explore?</h2><p className="mx-auto mt-3 max-w-md text-sm leading-6 text-zinc-500">Ask a question, explore an idea, or plan your next step. Auto chooses a chat model for your prompt.</p><div className="mt-7 grid gap-2 sm:grid-cols-3">{visibleExamples.map((example) => <button type="button" key={example.label} disabled={busy || reading || !models.length} onClick={() => { setDraft(example.prompt); setMode('auto'); setModel('auto'); textarea.current?.focus(); }} className="rounded-xl border border-zinc-200 p-4 text-left text-sm font-medium text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-40">{example.label}<span aria-hidden="true" className="mt-3 block text-zinc-400">↗</span></button>)}</div></div>}
          {messages.map((message) => {
            const jobId = message.role === 'assistant' ? parseMediaMarker(message.content) : null;
            const turn = message.role === 'user' ? decodeTurn(message.content) : { text: message.content, attachments: [] };
            return <article key={message.id} className={'mx-auto max-w-3xl ' + (message.role === 'user' ? 'flex flex-col items-end' : '')}><p className="mb-2 text-xs font-medium text-zinc-500">{message.role === 'user' ? 'You' : message.model}</p><div className={message.role === 'user' ? 'max-w-full space-y-3 rounded-2xl rounded-tr-sm bg-zinc-100 px-4 py-3' : 'space-y-3 text-zinc-900'}>{turn.attachments.length > 0 && <AttachmentCards files={turn.attachments} />}{jobId ? <MediaBubble key={jobId} jobId={jobId} startedAt={message.created_at} /> : <p className="whitespace-pre-wrap break-words text-sm leading-7">{turn.text || (message.role === 'assistant' && busy ? 'Thinking…' : '')}</p>}</div></article>;
          })}
        </div>
        <div className="px-3 pb-4 sm:px-6 sm:pb-5">
          {pendingGeneration && <div className="mb-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3"><GenerationProgress startedAt={pendingGeneration.startedAt} label={pendingGeneration.kind === 'image' ? 'Generating image' : 'Rendering video'} /></div>}
          {error && <div role="alert" className="mb-3 flex items-start gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700"><p className="min-w-0 flex-1 break-words">{error}</p><button type="button" onClick={() => setError('')} aria-label="Dismiss warning" className="shrink-0 rounded-md px-2 text-lg leading-5 hover:bg-red-700/10 focus-visible:outline-2 focus-visible:outline-offset-2">×</button></div>}
          <form onSubmit={(event) => void send(event)} className="rounded-2xl border border-zinc-300 bg-white p-3 shadow-sm transition focus-within:border-zinc-400 focus-within:ring-2 focus-within:ring-zinc-100">
            {attachments.length > 0 && <div className="mb-2"><AttachmentCards files={attachments} {...(!busy && !reading ? { onRemove: (index: number) => setAttachments((current) => current.filter((_, i) => i !== index)) } : {})} /></div>}
            <textarea ref={textarea} aria-label="Message" aria-describedby="composer-hint composer-route" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!event.repeat) event.currentTarget.form?.requestSubmit(); } }} onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void addFiles(files); } }} disabled={busy} maxLength={32000} rows={2} placeholder={dragging ? 'Drop your files here…' : 'Ask anything, or describe an idea…'} className="block max-h-44 min-h-16 w-full resize-none border-0 bg-transparent px-2 py-2 text-sm leading-6 text-zinc-900 outline-none placeholder:text-zinc-500" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input ref={fileInput} type="file" multiple accept={ATTACHMENT_ACCEPT} aria-label="Choose attachments" className="hidden" onChange={(event) => void addFiles(Array.from(event.target.files ?? []))} disabled={busy || reading} />
              <button type="button" onClick={() => fileInput.current?.click()} disabled={busy || reading} title="Attach images or text files · up to 3 files, 2 MB total" className="rounded-lg px-2.5 py-2 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"><span aria-hidden="true" className="mr-1 text-lg">＋</span>{reading ? 'Reading…' : 'Attach'}</button>
              <div role="group" aria-label="Response type" className="flex rounded-xl bg-zinc-100 p-1">{modes.map((value) => <button type="button" key={value} aria-pressed={mode === value} disabled={busy} onClick={() => { setMode(value); setModel('auto'); setError(''); }} className={'rounded-lg px-2.5 py-1.5 text-xs font-medium capitalize transition sm:px-3 ' + (mode === value ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-900')}>{value === 'auto' ? '✦ Auto' : value}</button>)}</div>
              <label className="min-w-0 max-w-full text-xs text-zinc-600"><span className="sr-only">Model</span><select aria-label="Model" disabled={busy} value={eligibleModels.includes(model) ? model : 'auto'} onChange={(event) => setModel(event.target.value)} className="max-w-full rounded-lg border-0 bg-transparent py-2 pr-2 text-xs sm:max-w-48"><option value="auto">Auto model</option>{eligibleModels.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
              <button type="submit" disabled={!canSend} aria-label={busy ? 'Sending prompt' : kind === 'chat' ? 'Send prompt' : 'Generate ' + kind} className="ml-auto flex h-10 items-center gap-2 rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white transition hover:opacity-85 disabled:opacity-35">{busy ? 'Working…' : kind === 'chat' ? 'Send' : 'Generate'}<span aria-hidden="true">↑</span></button>
            </div>
          </form>
          <div className="mt-3 flex flex-wrap justify-between gap-x-4 gap-y-1 px-1 text-[11px] leading-5 text-zinc-500"><p id="composer-route" className="min-w-0 break-words">{attachmentBlock ? 'Reference attachments are not supported for generation yet. Choose Chat to discuss these files.' : available ? (kind === 'chat' ? 'Chat' : 'Generate ' + kind) + ' · ' + available : 'No ' + (needsImages && kind === 'chat' ? 'image-capable chat' : kind) + ' models available for your plan and routing.'}</p><p id="composer-hint">Enter to send · Shift + Enter for a new line</p></div>
          <p className="mt-1 px-1 text-[11px] text-zinc-500">Drag files anywhere into the chat, or use Attach · Images and text files · 3 files, 2 MB total · Image input depends on model support. Video uploads are not supported yet.</p>
        </div>
      </section>
    </div>
  );
}
