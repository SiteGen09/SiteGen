'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { conversationSchema, savedMessageSchema, type Conversation, type SavedMessage } from '@/lib/chat/conversations';
import { ATTACHMENT_ACCEPT, attachmentsSchema, chooseModel, decodeTurn, detectMode, encodeTurn, readAttachment, supportsImages, supportsTextGeneration, type ChatAttachment, type ChatMode, type ComposerMode } from '@/lib/chat/composer';
import { canRetry, chatErrorSchema, describeError, errorAction, INTERRUPTED, showsReference, transportError, type ChatError, type ChatErrorKind } from '@/lib/chat/errors';
import { readSseData } from '@/lib/chat/sse';
import { parseMediaMarker } from '@/lib/media/marker';
import { createClient } from '@/lib/supabase/client';
import type { Family } from '@/lib/ai/source-types';
import { MediaBubble } from './media-bubble';
import { ModelPicker } from './model-picker';
import { GenerationProgress } from './generation-progress';

const frameSchema = z.object({
  model: z.string().optional(),
  error: chatErrorSchema.optional(),
  choices: z.array(z.object({ delta: z.object({ content: z.string().optional() }) })).optional(),
});
const failureSchema = z.object({ error: chatErrorSchema });
const mediaStartSchema = z.object({ id: z.string(), conversation_id: z.string().optional() });
const examples = [
  { label: 'Explore an idea', prompt: 'Help me brainstorm a memorable launch for a small coffee shop.', mode: 'chat' },
  { label: 'Create an image', prompt: 'Create an image of a cozy coffee shop on a rainy evening, warm cinematic lighting.', mode: 'image' },
  { label: 'Make a video', prompt: 'Generate a video of ocean waves at sunrise, with a slow cinematic camera movement.', mode: 'video' },
] as const;

/** A saved message, plus what only this browser knows about how its turn went. */
type Turn = SavedMessage & { state?: 'streaming' | 'stopped' | 'failed' | undefined; problem?: ChatError | undefined };
interface Notice { title?: string | undefined; message: string; kind?: ChatErrorKind | undefined; requestId?: string | undefined; tone: 'error' | 'warning' | 'info'; sticky: boolean }

/** Carries an already-worded failure out of the streaming loop. */
class TurnFailure extends Error {
  constructor(readonly problem: ChatError) { super(problem.message); }
}

async function readFailure(response: Response): Promise<ChatError> {
  const body = failureSchema.safeParse(await response.json().catch(() => null));
  // A proxy page or platform limit has no JSON body; word it from the status.
  return body.success ? body.data.error : transportError(response.status);
}

function problemFrom(err: unknown, accepted: boolean): ChatError {
  if (err instanceof TurnFailure) return err.problem;
  // fetch and stream reads reject with a TypeError when the network drops.
  if (err instanceof TypeError) return accepted ? INTERRUPTED : transportError();
  return { ...describeError({ code: 'internal_error', message: '', status: 500 }) };
}

const WARNING_KINDS = new Set<ChatErrorKind>(['credits', 'rate_limit', 'busy', 'paused']);
function noticeFrom(problem: ChatError): Notice {
  return { title: problem.title, message: problem.message, kind: problem.kind, requestId: problem.request_id, tone: WARNING_KINDS.has(problem.kind) ? 'warning' : 'error', sticky: true };
}

const TONES = {
  error: { box: 'bg-red-50 text-red-700', title: 'text-red-900', hover: 'hover:bg-red-700/10' },
  warning: { box: 'border border-amber-200 bg-amber-50 text-amber-800', title: 'text-amber-900', hover: 'hover:bg-amber-700/10' },
  info: { box: 'bg-zinc-100 text-zinc-700', title: 'text-zinc-900', hover: 'hover:bg-zinc-900/10' },
} as const;

function ProblemCard({ notice, onDismiss, children }: { notice: Notice; onDismiss?: () => void; children?: React.ReactNode }) {
  const tone = TONES[notice.tone];
  const action = notice.kind ? errorAction(notice.kind) : null;
  return (
    <div role={notice.tone === 'info' ? 'status' : 'alert'} className={'flex items-start gap-3 rounded-xl px-4 py-3 text-sm ' + tone.box}>
      <div className="min-w-0 flex-1 break-words">
        {notice.title && <p className={'font-medium ' + tone.title}>{notice.title}</p>}
        <p className={notice.title ? 'mt-0.5 leading-6' : 'leading-6'}>{notice.message}</p>
        {notice.requestId && notice.kind && showsReference(notice.kind) && <p className="mt-1 text-xs opacity-80">Reference: <span className="select-all font-mono">{notice.requestId}</span></p>}
        {(action || children) && <div className="mt-2 flex flex-wrap gap-2">
          {action && <Link href={action.href} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-85">{action.label}</Link>}
          {children}
        </div>}
      </div>
      {onDismiss && <button type="button" onClick={onDismiss} aria-label="Dismiss" className={'shrink-0 rounded-md px-2 text-lg leading-5 focus-visible:outline-2 focus-visible:outline-offset-2 ' + tone.hover}>×</button>}
    </div>
  );
}

const ICONS = {
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  copied: 'M5 12l5 5L20 7',
  edit: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
  retry: 'M20 11a8 8 0 1 0-2.34 5.66 M20 4v7h-7',
};

function ActionButton({ label, icon, onClick, disabled }: { label: string; icon: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40 disabled:hover:bg-transparent">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={icon} /></svg>
    </button>
  );
}

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

export function ChatWorkspace({ models, imageModels, videoModels, families, initialConversations }: {
  models: string[]; imageModels: string[]; videoModels: string[]; families: Record<string, Family>; initialConversations: Conversation[];
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<Turn[]>([]);
  const [mode, setMode] = useState<ComposerMode>('auto');
  const [model, setModel] = useState('auto');
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [stoppable, setStoppable] = useState(false);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const warn = useCallback((message: string) => {
    // A new occurrence of the same warning gets its own seven seconds.
    setNotice(message ? { message, tone: 'error', sticky: false } : null);
  }, []);
  const [pendingGeneration, setPendingGeneration] = useState<{ startedAt: string; kind: 'image' | 'video' } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const loadVersion = useRef(0);
  const sending = useRef(false);
  const readingFiles = useRef(false);
  const dragDepth = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editBox = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const modes: ComposerMode[] = ['auto', 'chat', ...(imageModels.length ? ['image' as const] : []), ...(videoModels.length ? ['video' as const] : [])];
  const visibleExamples = examples.filter((example) => example.mode === 'chat' || (example.mode === 'image' ? imageModels.length > 0 : videoModels.length > 0));

  // Transient warnings fade; a failure the person must act on stays until dismissed.
  useEffect(() => {
    if (!notice || notice.sticky) return;
    const timeout = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const kind: ChatMode = mode === 'auto' ? detectMode(draft) : mode;
  const needsImages = attachments.some((file) => file.kind === 'image') || messages.some((message) => message.role === 'user' && decodeTurn(message.content).attachments.some((file) => file.kind === 'image'));
  const modeModels = kind === 'image' ? imageModels : kind === 'video' ? videoModels : models;
  const eligibleModels = kind !== 'chat' ? modeModels.filter(supportsTextGeneration) : needsImages ? modeModels.filter(supportsImages) : modeModels;
  const autoModel = chooseModel(modeModels, kind, kind === 'chat' && needsImages);
  const available = model !== 'auto' && eligibleModels.includes(model) ? model : autoModel;
  const attachmentBlock = kind !== 'chat' && attachments.length > 0;
  const canSend = !busy && !reading && (draft.trim().length > 0 || attachments.length > 0) && !!available && !attachmentBlock;
  const idle = !busy && !reading;
  const editingId = editing?.id;

  useEffect(() => {
    if (transcript.current && followLatest.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages]);
  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = 'auto';
    textarea.current.style.height = Math.min(textarea.current.scrollHeight, 180) + 'px';
  }, [draft]);
  useEffect(() => {
    const box = editBox.current;
    if (!editingId || !box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, [editingId]);

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
    setNotice(null);
    try {
      if (attachments.length + files.length > 3) throw new Error('Attach up to 3 files per message.');
      const added = await Promise.all(files.map(readAttachment));
      const parsed = attachmentsSchema.safeParse([...attachments, ...added]);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Could not attach these files.');
      setAttachments(parsed.data);
    } catch (err) {
      warn(err instanceof Error ? err.message : 'Could not read the attachment.');
    } finally {
      readingFiles.current = false;
      setReading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  /** `fresh` resets the composer for a newly opened chat; a reload keeps it. */
  async function loadConversation(id: string, fresh: boolean): Promise<void> {
    if (sending.current || readingFiles.current) return;
    const version = ++loadVersion.current;
    setBusy(true);
    setNotice(null);
    setEditing(null);
    try {
      const result = await createClient().from('chat_messages').select('id, role, content, model, tokens, created_at').eq('conversation_id', id).order('created_at').order('id');
      const parsed = savedMessageSchema.array().safeParse(result.data);
      if (result.error || !parsed.success) throw new Error('Could not load conversation.');
      if (version !== loadVersion.current) return;
      setConversationId(id);
      followLatest.current = true;
      setMessages(parsed.data);
      if (fresh) {
        setAttachments([]);
        setDraft('');
        setMode('auto');
        setModel('auto');
        setHistoryOpen(false);
      }
    } catch {
      if (version === loadVersion.current) warn("Couldn't load this conversation. Check your connection and try again.");
    } finally {
      if (version === loadVersion.current) setBusy(false);
    }
  }

  /** The chat model a resent turn uses: the selection when it fits, otherwise Auto's pick. */
  function chatModelFor(history: Turn[], files: ChatAttachment[]): string {
    const images = files.some((file) => file.kind === 'image') || history.some((message) => message.role === 'user' && decodeTurn(message.content).attachments.some((file) => file.kind === 'image'));
    const eligible = images ? models.filter(supportsImages) : models;
    return model !== 'auto' && eligible.includes(model) ? model : chooseModel(models, 'chat', images);
  }

  /**
   * Streams one chat turn after `keep`. With `replaceFrom`, the server swaps
   * that saved prompt and everything after it for this turn once it accepts.
   * `onNotSent` puts the person's text back when the turn never started.
   */
  async function streamReply({ content, files, keep, chatModel, replaceFrom, onNotSent }: {
    content: string; files: ChatAttachment[]; keep: Turn[]; chatModel: string; replaceFrom?: string; onNotSent?: () => void;
  }): Promise<void> {
    if (sending.current || readingFiles.current) return;
    if (!chatModel) { warn('No chat models are available for your plan and routing. Check your routing settings.'); onNotSent?.(); return; }
    sending.current = true;
    setBusy(true);
    setStoppable(true);
    setNotice(null);
    followLatest.current = true;
    const previous = messages;
    const now = new Date().toISOString();
    const promptId = crypto.randomUUID();
    let replyId = crypto.randomUUID();
    const patchReply = (patch: (message: Turn) => Turn) => setMessages((current) => current.map((message) => message.id === replyId ? patch(message) : message));
    setMessages([
      ...keep,
      { id: promptId, role: 'user', content: encodeTurn(content, files), model: chatModel, tokens: null, created_at: now },
      { id: replyId, role: 'assistant', content: '', model: chatModel, tokens: null, created_at: now, state: 'streaming' },
    ]);
    const controller = new AbortController();
    abort.current = controller;
    let accepted = false;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, model: chatModel, content, attachments: files, ...(replaceFrom ? { replaceFrom } : {}) }),
        signal: controller.signal,
      });
      if (!response.ok) throw new TurnFailure(await readFailure(response));
      accepted = true;
      const id = response.headers.get('x-conversation-id');
      if (id) setConversationId(id);
      // Adopt the saved ids so this turn can be edited or regenerated later.
      const savedPrompt = response.headers.get('x-user-message-id');
      const savedReply = response.headers.get('x-assistant-message-id');
      const localReply = replyId;
      setMessages((current) => current.map((message) => message.id === promptId && savedPrompt ? { ...message, id: savedPrompt }
        : message.id === localReply && savedReply ? { ...message, id: savedReply } : message));
      if (savedReply) replyId = savedReply;
      if (!response.body) throw new TurnFailure(INTERRUPTED);
      let done = false;
      for await (const data of readSseData(response.body)) {
        if (data === '[DONE]') { done = true; break; }
        const frame = frameSchema.parse(JSON.parse(data));
        if (frame.error) throw new TurnFailure(frame.error);
        if (frame.model) patchReply((message) => ({ ...message, model: frame.model! }));
        const text = frame.choices?.[0]?.delta.content;
        if (text) patchReply((message) => ({ ...message, content: message.content + text }));
      }
      if (!done) throw new TurnFailure(INTERRUPTED);
    } catch (err) {
      if (!accepted) {
        setMessages(previous);
        onNotSent?.();
        setNotice(controller.signal.aborted
          ? { title: 'Stopped', message: "Your message wasn't sent, so you can change it and send it again.", tone: 'info', sticky: false }
          : noticeFrom(problemFrom(err, false)));
      } else if (controller.signal.aborted) {
        patchReply((message) => ({ ...message, state: 'stopped' }));
      } else {
        const problem = problemFrom(err, true);
        patchReply((message) => ({ ...message, state: 'failed', problem }));
      }
    } finally {
      patchReply((message) => message.state === 'streaming' ? { ...message, state: undefined } : message);
      abort.current = null;
      setStoppable(false);
      await refreshConversations();
      sending.current = false;
      setBusy(false);
      requestAnimationFrame(() => textarea.current?.focus());
    }
  }

  async function generateMedia(content: string, media: 'image' | 'video'): Promise<void> {
    if (content.length > 5000) { warn('Image and video prompts can be up to 5,000 characters.'); return; }
    sending.current = true;
    setBusy(true);
    setNotice(null);
    followLatest.current = true;
    const previous = messages;
    const now = new Date().toISOString();
    const userTurn: Turn = { id: crypto.randomUUID(), role: 'user', content: encodeTurn(content, attachments), model: available, tokens: null, created_at: now };
    try {
      setPendingGeneration({ startedAt: now, kind: media });
      const response = await fetch('/api/media', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId, kind: media, model: available, prompt: content }) });
      if (!response.ok) throw new TurnFailure(await readFailure(response));
      const body = mediaStartSchema.safeParse(await response.json());
      if (!body.success) throw new TurnFailure(transportError(500));
      const id = response.headers.get('x-conversation-id') ?? body.data.conversation_id;
      if (id) setConversationId(id);
      setMessages([...previous, userTurn, { id: crypto.randomUUID(), role: 'assistant', content: '[[media:' + body.data.id + ']]', model: available, tokens: null, created_at: now }]);
      setDraft('');
      setAttachments([]);
    } catch (err) {
      setNotice(noticeFrom(problemFrom(err, false)));
    } finally {
      setPendingGeneration(null);
      await refreshConversations();
      sending.current = false;
      setBusy(false);
      requestAnimationFrame(() => textarea.current?.focus());
    }
  }

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSend || sending.current || readingFiles.current) return;
    const content = draft.trim();
    if (kind !== 'chat') { await generateMedia(content, kind); return; }
    // Clear at once so the box is free while the reply streams; a turn that
    // never starts hands the text back.
    const raw = draft;
    const files = attachments;
    setDraft('');
    setAttachments([]);
    await streamReply({
      content, files, keep: messages, chatModel: available,
      onNotSent: () => {
        setDraft((current) => current || raw);
        setAttachments((current) => current.length ? current : files);
      },
    });
  }

  function stop(): void {
    abort.current?.abort();
  }

  /** Sends a saved prompt again, replacing it and everything after it. */
  function resend(prompt: Turn): void {
    const index = messages.findIndex((message) => message.id === prompt.id);
    if (index < 0 || prompt.role !== 'user') return;
    const { text, attachments: files } = decodeTurn(prompt.content);
    const keep = messages.slice(0, index);
    void streamReply({ content: text, files, keep, chatModel: chatModelFor(keep, files), replaceFrom: prompt.id });
  }

  function regenerate(reply: Turn): void {
    const index = messages.findIndex((message) => message.id === reply.id);
    const prompt = messages.slice(0, Math.max(0, index)).findLast((message) => message.role === 'user');
    if (prompt) resend(prompt);
  }

  function submitEdit(prompt: Turn): void {
    if (!editing || editing.id !== prompt.id) return;
    const { attachments: files } = decodeTurn(prompt.content);
    const content = editing.text.trim();
    const index = messages.findIndex((message) => message.id === prompt.id);
    if ((!content && !files.length) || index < 0) return;
    const keep = messages.slice(0, index);
    const text = editing.text;
    setEditing(null);
    void streamReply({ content, files, keep, chatModel: chatModelFor(keep, files), replaceFrom: prompt.id, onNotSent: () => setEditing({ id: prompt.id, text }) });
  }

  async function copy(message: Turn): Promise<void> {
    try {
      await navigator.clipboard.writeText(message.role === 'user' ? decodeTurn(message.content).text : message.content);
      setCopiedId(message.id);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      warn("Couldn't copy to the clipboard. Select the text and copy it instead.");
    }
  }

  function newChat() {
    if (sending.current || readingFiles.current) return;
    ++loadVersion.current;
    setConversationId(undefined); setMessages([]); setAttachments([]); setDraft(''); setNotice(null); setEditing(null); setMode('auto'); setModel('auto'); setHistoryOpen(false);
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
      warn('Wait for the current response or file to finish, then drop your files again.');
      return;
    }
    void addFiles(Array.from(event.dataTransfer.files));
  }

  const actionRow = 'mt-1 flex gap-0.5 transition-opacity ';
  const hoverOnly = 'sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover:opacity-100';

  return (
    <div className="grid min-h-[70vh] overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm lg:grid-cols-[15rem_1fr]">
      <aside className={(historyOpen ? 'block ' : 'hidden ') + 'border-b border-zinc-200 bg-zinc-50 p-4 lg:block lg:border-r lg:border-b-0'}>
        <button disabled={busy || reading} onClick={newChat} className="mb-6 flex w-full items-center justify-center gap-2 rounded-xl bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:opacity-85 disabled:opacity-50"><span aria-hidden="true">＋</span> New chat</button>
        <p className="mb-3 px-2 text-[11px] font-semibold tracking-widest text-zinc-500 uppercase">Your conversations</p>
        <nav aria-label="Conversations" className="max-h-[56vh] space-y-1 overflow-y-auto">
          {!conversations.length && <p className="px-2 py-4 text-xs leading-6 text-zinc-500">Your conversations will appear here. Pick up where you left off anytime.</p>}
          {conversations.map((conversation) => <button key={conversation.id} disabled={busy || reading} onClick={() => void loadConversation(conversation.id, true)} aria-current={conversationId === conversation.id ? 'page' : undefined} className={'block w-full truncate rounded-xl px-3 py-2.5 text-left text-sm transition hover:bg-zinc-100 ' + (conversationId === conversation.id ? 'bg-white font-medium text-zinc-900 shadow-sm' : 'text-zinc-600')} title={conversation.title}>{conversation.title}</button>)}
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
          {messages.map((message, index) => {
            const isLast = index === messages.length - 1;
            if (message.role === 'user') {
              const turn = decodeTurn(message.content);
              const next = messages[index + 1];
              // Media prompts start a render, not a chat reply, so they are not resent here.
              const mediaPrompt = next?.role === 'assistant' && parseMediaMarker(next.content) !== null;
              if (editing?.id === message.id) {
                return <article key={message.id} className="mx-auto flex max-w-3xl flex-col items-end">
                  <p className="mb-2 text-xs font-medium text-zinc-500">Editing your message</p>
                  <form onSubmit={(event) => { event.preventDefault(); submitEdit(message); }} className="w-full max-w-2xl space-y-2 rounded-2xl border border-zinc-300 bg-white p-3 shadow-sm focus-within:border-zinc-400 focus-within:ring-2 focus-within:ring-zinc-100">
                    {turn.attachments.length > 0 && <AttachmentCards files={turn.attachments} />}
                    <textarea ref={editBox} aria-label="Edit message" value={editing.text} onChange={(event) => setEditing({ id: message.id, text: event.target.value })} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setEditing(null); } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!event.repeat) event.currentTarget.form?.requestSubmit(); } }} maxLength={32000} rows={3} className="block max-h-60 min-h-20 w-full resize-y border-0 bg-transparent px-1 py-1 text-sm leading-6 text-zinc-900 outline-none" />
                    <div className="flex flex-wrap items-center justify-end gap-2"><p className="mr-auto px-1 text-[11px] text-zinc-500">Sending replaces this message and every reply after it.</p><button type="button" onClick={() => setEditing(null)} className="rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100">Cancel</button><button type="submit" disabled={!idle || (!editing.text.trim() && !turn.attachments.length)} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-85 disabled:opacity-40">Save &amp; send</button></div>
                  </form>
                </article>;
              }
              return <article key={message.id} className="group mx-auto flex max-w-3xl flex-col items-end">
                <p className="mb-2 text-xs font-medium text-zinc-500">You</p>
                <div className="max-w-full space-y-3 rounded-2xl rounded-tr-sm bg-zinc-100 px-4 py-3">{turn.attachments.length > 0 && <AttachmentCards files={turn.attachments} />}{turn.text && <p className="whitespace-pre-wrap break-words text-sm leading-7">{turn.text}</p>}</div>
                <div className={actionRow + (isLast ? '' : hoverOnly)}>
                  {turn.text && <ActionButton label={copiedId === message.id ? 'Copied' : 'Copy message'} icon={copiedId === message.id ? ICONS.copied : ICONS.copy} onClick={() => void copy(message)} />}
                  {!mediaPrompt && <ActionButton label="Edit message" icon={ICONS.edit} disabled={!idle} onClick={() => setEditing({ id: message.id, text: turn.text })} />}
                  {isLast && !mediaPrompt && <ActionButton label="Send again" icon={ICONS.retry} disabled={!idle} onClick={() => resend(message)} />}
                </div>
              </article>;
            }
            const jobId = parseMediaMarker(message.content);
            const problem = message.state === 'failed' ? message.problem : undefined;
            return <article key={message.id} className="group mx-auto max-w-3xl">
              <p className="mb-2 text-xs font-medium text-zinc-500">{message.model}</p>
              <div className="space-y-3 text-zinc-900">
                {jobId ? <MediaBubble key={jobId} jobId={jobId} startedAt={message.created_at} />
                  : message.content ? <p className="whitespace-pre-wrap break-words text-sm leading-7">{message.content}</p>
                  : message.state === 'streaming' ? <p className="animate-pulse text-sm leading-7 text-zinc-500">Thinking…</p> : null}
                {message.state === 'stopped' && <p className="text-xs text-zinc-500">{message.content ? 'Stopped.' : 'Stopped before a reply was written.'}</p>}
                {problem && <ProblemCard notice={noticeFrom(problem)}>
                  {(problem.kind === 'interrupted' || problem.kind === 'unsaved') && conversationId && <button type="button" disabled={!idle} onClick={() => void loadConversation(conversationId, false)} className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-40">Reload conversation</button>}
                  {canRetry(problem.kind) && <button type="button" disabled={!idle} onClick={() => regenerate(message)} className="rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-40">Try again</button>}
                </ProblemCard>}
              </div>
              {!jobId && message.state !== 'streaming' && !problem && <div className={actionRow + (isLast ? '' : hoverOnly)}>
                {message.content && <ActionButton label={copiedId === message.id ? 'Copied' : 'Copy response'} icon={copiedId === message.id ? ICONS.copied : ICONS.copy} onClick={() => void copy(message)} />}
                {isLast && <ActionButton label="Regenerate response" icon={ICONS.retry} disabled={!idle} onClick={() => regenerate(message)} />}
              </div>}
            </article>;
          })}
        </div>
        <div className="px-3 pb-4 sm:px-6 sm:pb-5">
          {pendingGeneration && <div className="mb-3 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3"><GenerationProgress startedAt={pendingGeneration.startedAt} label={pendingGeneration.kind === 'image' ? 'Generating image' : 'Rendering video'} /></div>}
          {notice && <div className="mb-3"><ProblemCard notice={notice} onDismiss={() => setNotice(null)} /></div>}
          <form onSubmit={(event) => void send(event)} className="rounded-2xl border border-zinc-300 bg-white p-3 shadow-sm transition focus-within:border-zinc-400 focus-within:ring-2 focus-within:ring-zinc-100">
            {attachments.length > 0 && <div className="mb-2"><AttachmentCards files={attachments} {...(!busy && !reading ? { onRemove: (index: number) => setAttachments((current) => current.filter((_, i) => i !== index)) } : {})} /></div>}
            <textarea ref={textarea} aria-label="Message" aria-describedby="composer-hint composer-route" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape' && stoppable) { event.preventDefault(); stop(); } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!event.repeat) event.currentTarget.form?.requestSubmit(); } }} onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void addFiles(files); } }} disabled={busy && !stoppable} maxLength={32000} rows={2} placeholder={dragging ? 'Drop your files here…' : 'Ask anything, or describe an idea…'} className="block max-h-44 min-h-16 w-full resize-none border-0 bg-transparent px-2 py-2 text-sm leading-6 text-zinc-900 outline-none placeholder:text-zinc-500" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input ref={fileInput} type="file" multiple accept={ATTACHMENT_ACCEPT} aria-label="Choose attachments" className="hidden" onChange={(event) => void addFiles(Array.from(event.target.files ?? []))} disabled={busy || reading} />
              <button type="button" onClick={() => fileInput.current?.click()} disabled={busy || reading} title="Attach images or text files · up to 3 files, 2 MB total" className="rounded-lg px-2.5 py-2 text-sm text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"><span aria-hidden="true" className="mr-1 text-lg">＋</span>{reading ? 'Reading…' : 'Attach'}</button>
              <div role="group" aria-label="Response type" className="flex rounded-xl bg-zinc-100 p-1">{modes.map((value) => <button type="button" key={value} aria-pressed={mode === value} disabled={busy} onClick={() => { setMode(value); setModel('auto'); setNotice(null); }} className={'rounded-lg px-2.5 py-1.5 text-xs font-medium capitalize transition sm:px-3 ' + (mode === value ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-900')}>{value === 'auto' ? '✦ Auto' : value}</button>)}</div>
              <ModelPicker value={eligibleModels.includes(model) ? model : 'auto'} models={eligibleModels} families={families} autoHint={autoModel} disabled={busy} onChange={setModel} />
              {stoppable
                ? <button type="button" onClick={stop} aria-label="Stop generating" className="ml-auto flex h-10 items-center gap-2 rounded-xl border border-zinc-300 bg-white px-4 text-sm font-medium text-zinc-900 transition hover:bg-zinc-100"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-zinc-900" />Stop</button>
                : <button type="submit" disabled={!canSend} aria-label={busy ? 'Sending prompt' : kind === 'chat' ? 'Send prompt' : 'Generate ' + kind} className="ml-auto flex h-10 items-center gap-2 rounded-xl bg-zinc-900 px-4 text-sm font-medium text-white transition hover:opacity-85 disabled:opacity-35">{busy ? 'Working…' : kind === 'chat' ? 'Send' : 'Generate'}<span aria-hidden="true">↑</span></button>}
            </div>
          </form>
          <div className="mt-3 flex flex-wrap justify-between gap-x-4 gap-y-1 px-1 text-[11px] leading-5 text-zinc-500"><p id="composer-route" className="min-w-0 break-words">{attachmentBlock ? 'Reference attachments are not supported for generation yet. Choose Chat to discuss these files.' : available ? (kind === 'chat' ? 'Chat' : 'Generate ' + kind) + ' · ' + available : 'No ' + (needsImages && kind === 'chat' ? 'image-capable chat' : kind) + ' models available for your plan and routing.'}</p><p id="composer-hint">{stoppable ? 'Esc to stop · Stopping keeps what was written so far' : 'Enter to send · Shift + Enter for a new line'}</p></div>
          <p className="mt-1 px-1 text-[11px] text-zinc-500">Drag files anywhere into the chat, or use Attach · Images and text files · 3 files, 2 MB total · Image input depends on model support. Video uploads are not supported yet.</p>
        </div>
      </section>
    </div>
  );
}
