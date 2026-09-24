import { guardedRoute, admitGeneration } from '@/lib/guardrails/runtime';
import { randomUUID } from 'node:crypto';
import { after } from 'next/server';
import { z } from 'zod';
import type { ModelMessage } from 'ai';

import { dashboardErrorFrom } from '@/lib/api/dashboard-errors';
import { ApiError } from '@/lib/api/errors';
import { asUpstreamError } from '@/lib/api/upstream';
import { savedMessageSchema, type SavedMessage } from '@/lib/chat/conversations';
import { attachmentsSchema, decodeTurn, encodeTurn, supportsImages, turnText } from '@/lib/chat/composer';
import { describeError, type ChatError } from '@/lib/chat/errors';
import { parseMediaMarker } from '@/lib/media/marker';
import { prepareCall, settleCall, recordCallFailure, SSE_HEADERS } from '@/lib/chat/pipeline';
import { totalMessageChars } from '@/lib/chat/request';
import { streamChat } from '@/lib/chat/stream';
import { estimateStoppedUsage } from '@/lib/generate/estimate';
import { releaseCredits } from '@/lib/generate/ledger';
import { logger } from '@/lib/log';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const maxDuration = 300;

const requestSchema = z.object({
  conversationId: z.uuid().optional(),
  model: z.string().min(1).max(128),
  content: z.string().trim().max(32000),
  attachments: attachmentsSchema.default([]),
  // Edit and regenerate: this user message and everything after it are
  // replaced by the new turn, but only once the new turn has been accepted.
  replaceFrom: z.uuid().optional(),
})
  .refine((value) => value.content.length > 0 || value.attachments.length > 0, 'Enter a message or attach a file.')
  .refine((value) => !value.replaceFrom || value.conversationId, 'Reload the conversation and try again.');

/** Zod's defaults read like validator output; say what to change instead. */
function requestIssue(issue: z.core.$ZodIssue | undefined): string {
  if (issue === undefined) return 'Choose a model and enter a message.';
  const [field] = issue.path;
  if (field === 'content') return 'Messages can be up to 32,000 characters.';
  if (field === 'model') return 'Choose a model.';
  if (field === 'attachments') {
    if (issue.path.length === 1 && issue.code === 'too_big') return 'Attach up to 3 files per message.';
    if (issue.code === 'custom' || issue.code === 'invalid_format') return issue.message;
    return 'One of the attachments could not be read. Remove it and try again.';
  }
  return issue.code === 'custom' ? issue.message : 'Reload the page and try again.';
}

/** A stopped reply releases its lease within moments; wait for it rather than refuse. */
const CLAIM_ATTEMPTS = 16;
const CLAIM_RETRY_MS = 300;

function interruption(err: unknown, requestId: string): ChatError {
  const upstream = asUpstreamError(err);
  const cause = upstream === null ? null
    : describeError({ code: upstream.code, message: upstream.message, status: upstream.status });
  return {
    kind: cause?.kind ?? 'provider',
    title: 'Reply interrupted',
    message: (cause !== null && cause.kind !== 'server' ? cause.message
      : 'The AI provider stopped responding partway through the reply. Please try again.')
      + ' You were not charged for this reply.',
    request_id: requestId,
  };
}

async function handlePost(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: 'dashboard.chat' });
  const service = createServiceClient();
  const startedAt = Date.now();
  let conversationId: string | undefined;
  let ownerId: string | undefined;
  let created = false;
  let accepted = false;
  let held = false;
  let channelId: string | null = null;
  let lease = false;
  // The browser leaving stops the upstream, and so does a failure of ours
  // after the upstream has started.
  const halt = new AbortController();
  const upstreamSignal = AbortSignal.any([req.signal, halt.signal]);

  async function unlock(): Promise<void> {
    if (!lease || !conversationId || !ownerId) return;
    await service
      .from('chat_conversations')
      .update({ active_request_id: null, locked_until: null })
      .eq('id', conversationId)
      .eq('user_id', ownerId)
      .eq('active_request_id', requestId);
  }

  /** A first turn that never got accepted must not leave an empty conversation behind. */
  async function discardCreated(): Promise<void> {
    if (!created || accepted || !conversationId || !ownerId) return;
    const { error } = await service
      .from('chat_conversations')
      .delete()
      .eq('id', conversationId)
      .eq('user_id', ownerId);
    if (error) log.warn('dashboard.chat_discard_failed', { db_error: error.code });
  }

  /**
   * The browser left before the reply began, which is how Stop looks this
   * early: nothing reached the person, so nothing is saved or charged.
   */
  async function cancel(): Promise<Response> {
    halt.abort();
    if (held) {
      await releaseCredits(requestId).catch(() => {
        log.error('dashboard.chat_release_failed', { alert: true });
      });
      held = false;
    }
    await unlock();
    await discardCreated();
    log.info('dashboard.chat_cancelled', { channel_id: channelId });
    return new Response(null, { status: 499 });
  }

  try {
    // Session identity comes from Supabase verification, never a submitted user id.
    const session = await createClient();
    const {
      data: { user },
      error: authError,
    } = await session.auth.getUser();
    if (authError || !user) throw new ApiError('unauthorized', 'Sign in to chat.', 401);
    ownerId = user.id;
    await admitGeneration(user.id);
    const origin = req.headers.get('origin');
    if (origin !== null && origin !== new URL(req.url).origin)
      throw new ApiError('forbidden', 'Invalid request origin.', 403);
    const profile = await service.from('profiles').select('status').eq('id', user.id).single();
    if (profile.error || profile.data?.status !== 'active')
      throw new ApiError('forbidden', 'Chat is unavailable for this account.', 403);
    const body = requestSchema.safeParse(await req.json().catch(() => null));
    if (!body.success) throw new ApiError('invalid_request', requestIssue(body.error.issues[0]), 400);
    const input = body.data;
    conversationId = input.conversationId ?? randomUUID();
    if (!input.conversationId) {
      const { error } = await service.from('chat_conversations').insert({
        id: conversationId,
        user_id: user.id,
        title: (input.content || input.attachments[0]?.name || 'New chat').slice(0, 80),
        model: input.model,
      });
      if (error) throw new Error('Could not create conversation');
      created = true;
    }
    // An owner-filtered compare-and-set protects against concurrent turns. The
    // expiry only recovers leases left by a terminated process, after maxDuration.
    for (let attempt = 1; ; attempt += 1) {
      const claimed = await service
        .from('chat_conversations')
        .update({
          active_request_id: requestId,
          locked_until: new Date(Date.now() + 600000).toISOString(),
        })
        .eq('id', conversationId)
        .eq('user_id', user.id)
        .or('active_request_id.is.null,locked_until.lt.' + new Date().toISOString())
        .select('id')
        .maybeSingle();
      if (claimed.error) throw new Error('Could not claim conversation');
      if (claimed.data) break;
      if (attempt === 1) {
        const owned = await service
          .from('chat_conversations')
          .select('id')
          .eq('id', conversationId)
          .eq('user_id', user.id)
          .maybeSingle();
        if (!owned.error && !owned.data) throw new ApiError('not_found', 'no such conversation', 404);
      }
      if (attempt >= CLAIM_ATTEMPTS || req.signal.aborted)
        throw new ApiError('invalid_request', 'Conversation unavailable or already answering.', 409);
      await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_MS));
    }
    lease = true;
    const history = await session
      .from('chat_messages')
      .select('id, role, content, model, tokens, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(100);
    if (history.error) throw new Error('Could not read conversation');
    let saved = savedMessageSchema.array().parse(history.data).reverse();
    let replaced: SavedMessage | undefined;
    if (input.replaceFrom) {
      const index = saved.findIndex((message) => message.id === input.replaceFrom && message.role === 'user');
      if (index < 0)
        throw new ApiError('invalid_request', 'That message can no longer be edited. Reload the conversation and try again.', 409);
      replaced = saved[index];
      saved = saved.slice(0, index);
    }
    const turns = saved
      // A reply stopped before any text is not saved, but skip blanks anyway:
      // some providers reject an empty assistant turn outright.
      .filter((message) => message.role !== 'assistant' || (message.content.trim() !== '' && !parseMediaMarker(message.content)))
      .map(({ role, content }) => ({ role, ...(role === 'user' ? decodeTurn(content) : { text: content, attachments: [] }) }));
    turns.push({ role: 'user', text: input.content, attachments: input.attachments });
    const imageCount = turns.reduce((sum, turn) => sum + turn.attachments.filter((file) => file.kind === 'image').length, 0);
    if (imageCount > 0 && !supportsImages(input.model))
      throw new ApiError('invalid_request', 'This conversation includes images. Choose a model that can read images.', 400);
    if (imageCount > 12)
      throw new ApiError('invalid_request', 'This conversation has too many images. Start a new chat.', 400);
    const messages = turns.map((turn) => ({
      role: turn.role,
      // Include a conservative image allowance in the existing credit estimate.
      content: turnText(turn.text, turn.attachments) + turn.attachments
        .filter((file) => file.kind === 'image').map(() => ' '.repeat(8000)).join(''),
    }));
    const modelMessages: ModelMessage[] = turns.map((turn) => {
      const text = turnText(turn.text, turn.attachments);
      if (turn.role !== 'user') return { role: turn.role, content: text };
      return { role: 'user', content: [
        { type: 'text', text: text || 'Please review the attached image.' },
        ...turn.attachments.flatMap((file) => file.kind === 'image'
          ? [{ type: 'file' as const, data: file.data, mediaType: file.data.slice(5, file.data.indexOf(';')), filename: file.name }] : []),
      ] };
    });
    if (messages.reduce((sum, message) => sum + message.content.length, 0) > 200000) {
      throw new ApiError('invalid_request', 'This conversation is full. Start a new chat.', 400);
    }
    const auth = { ownerId: user.id, apiKeyId: null };
    const prepared = await prepareCall({
      requestId,
      auth,
      log,
      model: input.model,
      messages,
      maxOutputField: 'max_tokens',
    });
    if (!prepared.ok) throw prepared.error;
    held = prepared.held;
    channelId = prepared.resolved.start.id;
    if (req.signal.aborted) return await cancel();
    const handle = await streamChat({
      start: prepared.resolved.start,
      resolve: prepared.resolved.resolve,
      buildCreds: prepared.resolved.buildCreds,
      messages,
      modelMessages,
      maxOutputTokens: prepared.requestedMax,
      abortSignal: upstreamSignal,
    });
    channelId = handle.channel.id;
    // Observe rejection immediately; iteration will report it in-band too.
    void handle.completion.catch(() => undefined);
    if (req.signal.aborted) return await cancel();
    // Accepted: the upstream is answering and the browser is still waiting.
    // Only now may an edit discard the turns it replaces, and only now is the
    // prompt saved, so a refusal above leaves the conversation as it was.
    if (replaced) {
      const removed = await service
        .from('chat_messages')
        .delete()
        .eq('conversation_id', conversationId)
        .gte('created_at', replaced.created_at);
      if (removed.error) throw new Error('Could not replace messages');
    }
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const userWrite = await service.from('chat_messages').insert({
      id: userMessageId,
      conversation_id: conversationId,
      role: 'user',
      content: encodeTurn(input.content, input.attachments),
      model: input.model,
    });
    if (userWrite.error) throw new Error('Could not save message');
    accepted = true;
    // A retry may answer with a different public model. Label and save the
    // model that actually served the response, without exposing upstream IDs.
    let responseModel = input.model;
    if (handle.channel.id !== prepared.resolved.start.id) {
      try {
        const actual = await service.from('channels').select('public_model_id').eq('id', handle.channel.id).maybeSingle();
        if (!actual.error && typeof actual.data?.public_model_id === 'string') responseModel = actual.data.public_model_id;
      } catch { /* Metadata lookup must not discard an accepted stream. */ }
    }
    let disconnected = false;
    let work: Promise<void> = Promise.resolve();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        function send(value: unknown): void {
          if (!disconnected)
            controller.enqueue(
              encoder.encode(
                'data: ' + (value === '[DONE]' ? value : JSON.stringify(value)) + '\n\n',
              ),
            );
        }
        work = (async () => {
          let settled = false;
          try {
            let content = '';
            try {
              for await (const part of handle.partStream) {
                if (part.type !== 'text') continue;
                content += part.text;
                send({
                  model: responseModel,
                  choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
                });
              }
            } catch (err) {
              // An abort normally just ends the stream, but a read in flight
              // can also reject with it.
              if (!req.signal.aborted) throw err;
            }
            // Stop (or a dropped connection) aborts the upstream, which then
            // never reports usage. The provider still bills the prompt and the
            // text produced so far, so the turn is settled on an estimate.
            const done = await handle.completion.catch((err: unknown) => {
              if (req.signal.aborted) return null;
              throw err;
            });
            const usage = done?.usage
              ?? estimateStoppedUsage(totalMessageChars(messages), content.length, prepared.requestedMax);
            await settleCall({
              requestId,
              auth,
              log,
              channelId: handle.channel.id,
              held,
              multiplier: Number(handle.channel.creditMultiplier),
              byok: handle.channel.isByok,
              rates: handle.channel.rates,
              usage,
              latencyMs: done?.latencyMs ?? Date.now() - startedAt,
              estimated: done === null,
            });
            settled = true;
            if (done !== null || content.trim() !== '') {
              const saved = await service.from('chat_messages').insert({
                id: assistantMessageId,
                conversation_id: conversationId,
                role: 'assistant',
                content,
                model: responseModel,
                tokens: usage.outputTokens,
              });
              if (saved.error) throw new Error('Could not save assistant response');
            }
            const updated = await service
              .from('chat_conversations')
              .update({ model: responseModel, updated_at: new Date().toISOString() })
              .eq('id', conversationId)
              .eq('user_id', user.id);
            if (updated.error) throw new Error('Could not update conversation');
            if (done === null) log.info('dashboard.chat_stopped', { output_chars: content.length });
            send({ model: responseModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          } catch (err) {
            log.error('dashboard.chat_failed', {
              detail: err instanceof Error ? err.message : 'unknown',
            });
            // A persistence failure after successful settlement must not refund
            // consumed tokens or overwrite the successful usage event.
            if (!settled)
              await recordCallFailure({ requestId, auth, log, channelId, held }).catch(
                () => undefined,
              );
            send({
              error: settled
                ? {
                    kind: 'unsaved',
                    title: 'Reply not saved',
                    message: "Your reply was generated and billed, but it couldn't be saved. Reload the conversation, and contact support if it's missing.",
                    request_id: requestId,
                  } satisfies ChatError
                : interruption(err, requestId),
            });
          } finally {
            await unlock();
            send('[DONE]');
            if (!disconnected) controller.close();
          }
        })();
      },
      // Keep settling and saving after a disconnect. Next's after() keeps
      // that promise alive even when the browser abandons the response body.
      cancel() {
        disconnected = true;
      },
    });
    after(async () => {
      await work;
    });
    return new Response(stream, {
      headers: {
        ...SSE_HEADERS,
        'x-conversation-id': conversationId,
        'x-user-message-id': userMessageId,
        'x-assistant-message-id': assistantMessageId,
      },
    });
  } catch (err) {
    halt.abort();
    if (req.signal.aborted && !accepted) return await cancel();
    if (held && ownerId)
      await recordCallFailure({
        requestId,
        auth: { ownerId, apiKeyId: null },
        log,
        channelId,
        held,
      }).catch(() => undefined);
    await unlock();
    await discardCreated();
    if (!(err instanceof ApiError))
      log.error('dashboard.chat_rejected', { detail: err instanceof Error ? err.message : 'unknown' });
    return dashboardErrorFrom(err, requestId);
  }
}

export const POST = guardedRoute(handlePost, dashboardErrorFrom, 4 * 1024 * 1024);
