import { guardedRoute, admitGeneration } from '@/lib/guardrails/runtime';
import { randomUUID } from 'node:crypto';
import { after } from 'next/server';
import { z } from 'zod';
import type { ModelMessage } from 'ai';

import { ApiError } from '@/lib/api/errors';
import { openAiErrorFrom } from '@/lib/api/openai-errors';
import { savedMessageSchema } from '@/lib/chat/conversations';
import { attachmentsSchema, decodeTurn, encodeTurn, supportsImages, turnText } from '@/lib/chat/composer';
import { parseMediaMarker } from '@/lib/media/marker';
import { prepareCall, settleCall, recordCallFailure, SSE_HEADERS } from '@/lib/chat/pipeline';
import { streamChat } from '@/lib/chat/stream';
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
}).refine((value) => value.content.length > 0 || value.attachments.length > 0, 'Enter a message or attach a file.');

async function handlePost(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: 'dashboard.chat' });
  const service = createServiceClient();
  let conversationId: string | undefined;
  let ownerId: string | undefined;
  let held = false;
  let channelId: string | null = null;
  let lease = false;

  async function unlock(): Promise<void> {
    if (!lease || !conversationId || !ownerId) return;
    await service
      .from('chat_conversations')
      .update({ active_request_id: null, locked_until: null })
      .eq('id', conversationId)
      .eq('user_id', ownerId)
      .eq('active_request_id', requestId);
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
    if (!body.success)
      throw new ApiError(
        'invalid_request',
        body.error.issues[0]?.message ?? 'Choose a model and enter a message of at most 32,000 characters.',
        400,
      );
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
    }
    // An owner-filtered compare-and-set protects against concurrent turns. The
    // expiry only recovers leases left by a terminated process, after maxDuration.
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
    if (claimed.error || !claimed.data)
      throw new ApiError('invalid_request', 'Conversation unavailable or already answering.', 409);
    lease = true;
    const history = await session
      .from('chat_messages')
      .select('id, role, content, model, tokens, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(100);
    if (history.error) throw new Error('Could not read conversation');
    const turns = savedMessageSchema
      .array()
      .parse(history.data)
      .reverse()
      .filter((message) => message.role !== 'assistant' || !parseMediaMarker(message.content))
      .map(({ role, content }) => ({ role, ...(role === 'user' ? decodeTurn(content) : { text: content, attachments: [] }) }));
    turns.push({ role: 'user', text: input.content, attachments: input.attachments });
    const imageCount = turns.reduce((sum, turn) => sum + turn.attachments.filter((file) => file.kind === 'image').length, 0);
    if (imageCount > 0 && !supportsImages(input.model))
      throw new ApiError('invalid_request', 'Choose an image-capable model for this conversation.', 400);
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
    if (!prepared.ok) {
      await unlock();
      return Response.json(prepared.response.body, { status: prepared.response.status });
    }
    held = prepared.held;
    channelId = prepared.resolved.start.id;
    const userWrite = await service.from('chat_messages').insert({
      conversation_id: conversationId,
      role: 'user',
      content: encodeTurn(input.content, input.attachments),
      model: input.model,
    });
    if (userWrite.error) throw new Error('Could not save message');
    const handle = await streamChat({
      start: prepared.resolved.start,
      resolve: prepared.resolved.resolve,
      buildCreds: prepared.resolved.buildCreds,
      messages,
      modelMessages,
      maxOutputTokens: prepared.requestedMax,
    });
    channelId = handle.channel.id;
    void handle.completion.catch(() => undefined);
    // A retry may answer with a different public model. Label and save the
    // model that actually served the response, without exposing upstream IDs.
    let responseModel = input.model;
    if (handle.channel.id !== prepared.resolved.start.id) {
      try {
        const actual = await service.from('channels').select('public_model_id').eq('id', handle.channel.id).maybeSingle();
        if (!actual.error && typeof actual.data?.public_model_id === 'string') responseModel = actual.data.public_model_id;
      } catch { /* Metadata lookup must not discard an accepted stream. */ }
    }
    // Observe rejection immediately; iteration will report it in-band too.
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
            for await (const part of handle.partStream) {
              if (part.type !== 'text') continue;
              content += part.text;
              send({
                model: responseModel,
                choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
              });
            }
            const done = await handle.completion;
            await settleCall({
              requestId,
              auth,
              log,
              channelId: handle.channel.id,
              held,
              multiplier: Number(handle.channel.creditMultiplier),
              byok: handle.channel.isByok,
              rates: handle.channel.rates,
              usage: done.usage,
              latencyMs: done.latencyMs,
            });
            settled = true;
            const saved = await service.from('chat_messages').insert({
              conversation_id: conversationId,
              role: 'assistant',
              content,
              model: responseModel,
              tokens: done.usage.outputTokens,
            });
            if (saved.error) throw new Error('Could not save assistant response');
            const updated = await service
              .from('chat_conversations')
              .update({ model: responseModel, updated_at: new Date().toISOString() })
              .eq('id', conversationId)
              .eq('user_id', user.id);
            if (updated.error) throw new Error('Could not update conversation');
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
              error: {
                message: settled
                  ? 'The response was billed but could not be saved. Please reload.'
                  : 'The upstream response ended early.',
              },
            });
          } finally {
            await unlock();
            send('[DONE]');
            if (!disconnected) controller.close();
          }
        })();
      },
      // Keep consuming and settling after a disconnect. Next's after() keeps
      // that promise alive even when the browser abandons the response body.
      cancel() {
        disconnected = true;
      },
    });
    after(async () => {
      await work;
    });
    return new Response(stream, {
      headers: { ...SSE_HEADERS, 'x-conversation-id': conversationId },
    });
  } catch (err) {
    if (held && ownerId)
      await recordCallFailure({
        requestId,
        auth: { ownerId, apiKeyId: null },
        log,
        channelId,
        held,
      }).catch(() => undefined);
    await unlock();
    return openAiErrorFrom(err, requestId);
  }
}

export const POST = guardedRoute(handlePost, openAiErrorFrom, 4 * 1024 * 1024);
