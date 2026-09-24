import { guardedRoute, admitGeneration } from '@/lib/guardrails/runtime';
import { randomUUID } from 'node:crypto';

import { authenticateApiKey, requireScope, type AuthenticatedKey } from '@/lib/api/api-key-auth';
import { ApiError } from '@/lib/api/errors';
import { asUpstreamError } from '@/lib/api/upstream';
import {
  anthropicError,
  anthropicErrorBody,
  anthropicErrorFrom,
} from '@/lib/api/anthropic-errors';
import { withIdempotency, type IdempotentResponse } from '@/lib/api/idempotency';
import { generateChat } from '@/lib/chat/generate';
import { streamChat, type ChatStreamHandle } from '@/lib/chat/stream';
import type { ChatMessage, ChatTool } from '@/lib/chat/request';
import {
  SSE_HEADERS,
  readIdempotencyKey,
  prepareCall,
  settleCall,
  recordCallFailure,
  type Preflight,
} from '@/lib/chat/pipeline';
import {
  messagesRequestSchema,
  messagesRequestHash,
  toChatMessages,
  toChatTools,
  toChatToolChoice,
  type MessagesRequest,
} from '@/lib/messages/request';
import { createMessageFrames, messageObject } from '@/lib/messages/response';
import { consumeRateLimit, getBalance } from '@/lib/generate/ledger';
import type { Logger } from '@/lib/log';
import { logger } from '@/lib/log';

/**
 * The Anthropic Messages API, served by this gateway.
 *
 * Structurally a sibling of `/v1/responses`: a third wire format over the same
 * pipeline, so model resolution, moderation, plan ceilings, holds and
 * settlement are shared and cannot drift between protocols. What differs is
 * the envelope in and out — and the auth header, since Anthropic clients send
 * `x-api-key` rather than `Authorization: Bearer`.
 *
 * Note this is independent of the `anthropic` provider kind, which describes
 * what a channel speaks *upstream*. A request arriving here may be served by
 * an OpenAI-compatible channel; that is the point of accepting it.
 */

const SCOPE = 'chat' as const;

interface MessageContext {
  requestId: string;
  auth: AuthenticatedKey;
  body: MessagesRequest;
  log: Logger;
}

/**
 * Anthropic SDKs authenticate with `x-api-key`. Bearer is accepted too, so a
 * caller that already has an OpenAI-style client configured against this
 * gateway does not have to change how it sends the key to switch protocols.
 */
function readAuthHeader(req: Request): string | null {
  const bearer = req.headers.get('authorization');
  if (bearer !== null && bearer.length > 0) return bearer;

  const apiKey = req.headers.get('x-api-key');
  return apiKey === null || apiKey.length === 0 ? null : `Bearer ${apiKey}`;
}

/** Parses the body without rejecting unknown fields. */
async function parseBody(req: Request): Promise<MessagesRequest> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError('invalid_request', 'request body must be valid JSON', 400);
  }

  const parsed = messagesRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    const message = issue !== undefined ? `${where}${issue.message}` : 'invalid request body';
    throw new ApiError('invalid_request', message, 400);
  }

  return parsed.data;
}

/**
 * Preflight plus the translated chat form. Translating once and handing the
 * result back keeps preflight and the upstream call on identical content, so
 * the hold is sized from exactly what gets sent.
 */
interface PreparedMessage {
  preflight: Preflight;
  messages: ChatMessage[];
  tools: ChatTool[] | undefined;
}

async function prepareMessage(ctx: MessageContext): Promise<PreparedMessage> {
  const messages = toChatMessages(ctx.body);
  const tools = toChatTools(ctx.body);

  const preflight = await prepareCall({
    requestId: ctx.requestId,
    auth: ctx.auth,
    log: ctx.log,
    model: ctx.body.model,
    messages,
    tools,
    maxOutputTokens: ctx.body.max_tokens,
    maxOutputField: 'max_tokens',
  });

  return { preflight, messages, tools };
}

/**
 * The pipeline reports refusals in OpenAI's envelope. A Messages client cannot
 * read that, so the code and message are lifted across into Anthropic's.
 */
function toAnthropicRefusal(response: IdempotentResponse, requestId: string): IdempotentResponse {
  const body = response.body as { error?: { code?: string; message?: string } };
  const code = body.error?.code;
  const message = body.error?.message ?? 'the request could not be completed';
  // `code` round-trips from our own ErrorCode except where openAiErrorBody
  // renames it; those three are mapped back so the type stays accurate.
  const internal =
    code === 'insufficient_quota'
      ? 'insufficient_credits'
      : code === 'rate_limit_exceeded'
        ? 'rate_limited'
        : code === 'invalid_api_key'
          ? 'unauthorized'
          : code;

  return {
    status: response.status,
    body: anthropicErrorBody(
      (internal ?? 'internal_error') as Parameters<typeof anthropicErrorBody>[0],
      message,
      requestId,
    ),
  };
}

/**
 * Runs one priced message and returns the value to persist for the idempotency
 * key. Expected non-success outcomes are returned as their own stored
 * response; unexpected failures throw and are mapped by the caller.
 */
async function runMessage(ctx: MessageContext): Promise<IdempotentResponse> {
  const { requestId, auth, body, log } = ctx;

  const { preflight, messages, tools } = await prepareMessage(ctx);
  if (!preflight.ok) return toAnthropicRefusal(preflight.response, requestId);
  const { resolved, requestedMax, held } = preflight;

  try {
    const generation = await generateChat({
      start: resolved.start,
      resolve: resolved.resolve,
      buildCreds: resolved.buildCreds,
      messages,
      maxOutputTokens: requestedMax,
      temperature: body.temperature,
      topP: body.top_p,
      tools,
      toolChoice: toChatToolChoice(body),
    });

    const settled = await settleCall({
      requestId,
      auth,
      log,
      channelId: generation.channelId,
      held,
      multiplier: generation.multiplier,
      byok: generation.byok,
      rates: generation.rates,
      usage: generation.usage,
      latencyMs: generation.latencyMs,
    });

    const balanceAfter = await getBalance(auth.ownerId);

    log.info('messages.ok', {
      channel_id: generation.channelId,
      latency_ms: generation.latencyMs,
      credits_charged: settled.creditsCharged,
      balance_after: balanceAfter,
    });

    // The PUBLIC model name is echoed, never the upstream model_id.
    return {
      status: 200,
      body: messageObject({
        requestId,
        model: body.model,
        content: generation.content,
        toolCalls: generation.toolCalls,
        finishReason: generation.finishReason,
        usage: generation.usage,
      }),
    };
  } catch (err) {
    await recordCallFailure({ requestId, auth, log, channelId: resolved.start.id, held });
    throw err;
  }
}

/** Accumulated state for one streamed tool call, keyed by wire index. */
interface StreamingToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Streams one priced message as Anthropic-shaped SSE.
 *
 * Coding harnesses hold this connection open for a whole turn, which fixes two
 * things about billing. Every refusal must happen in `prepareMessage`, before
 * the 200 is committed; and settlement can only run once the upstream stream
 * ends, so it hangs off the completion promise rather than the response body —
 * a client that hangs up mid-turn has still consumed the tokens and is still
 * charged for them.
 */
async function runMessageStream(ctx: MessageContext): Promise<Response> {
  const { requestId, auth, body, log } = ctx;

  const { preflight, messages, tools } = await prepareMessage(ctx);
  if (!preflight.ok) {
    const refusal = toAnthropicRefusal(preflight.response, requestId);
    return Response.json(refusal.body, { status: refusal.status });
  }
  const { resolved, requestedMax, held } = preflight;

  let handle: ChatStreamHandle;
  try {
    handle = await streamChat({
      start: resolved.start,
      resolve: resolved.resolve,
      buildCreds: resolved.buildCreds,
      messages,
      maxOutputTokens: requestedMax,
      temperature: body.temperature,
      topP: body.top_p,
      tools,
      toolChoice: toChatToolChoice(body),
    });
  } catch (err) {
    // Nothing has been written yet, so this can still be a normal JSON error.
    await recordCallFailure({ requestId, auth, log, channelId: resolved.start.id, held });
    throw err;
  }

  // Deliberately not part of the response body: if the client disconnects,
  // this still runs to completion.
  const billing = (async () => {
    try {
      const done = await handle.completion;
      const settled = await settleCall({
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
      log.info('messages.stream_ok', {
        channel_id: handle.channel.id,
        latency_ms: done.latencyMs,
        credits_charged: settled.creditsCharged,
      });
    } catch (err) {
      log.error('messages.stream_failed', {
        detail: err instanceof Error ? err.message : String(err),
      });
      await recordCallFailure({
        requestId,
        auth,
        log,
        channelId: handle.channel.id,
        held,
      }).catch(() => undefined);
    }
  })();

  const encoder = new TextEncoder();
  const frames = createMessageFrames({ requestId, model: body.model });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string): void => {
        if (text !== '') controller.enqueue(encoder.encode(text));
      };
      try {
        send(frames.start());

        // `tool-call-delta` carries only an index, so the id and name from the
        // opening part have to be remembered to address later frames.
        const calls = new Map<number, StreamingToolCall>();

        for await (const part of handle.partStream) {
          switch (part.type) {
            case 'text':
              send(frames.textDelta(part.text));
              break;
            case 'tool-call-start':
              calls.set(part.index, { id: part.id, name: part.name, arguments: '' });
              send(frames.toolCallStart(part.id, part.name));
              break;
            case 'tool-call-delta': {
              const call = calls.get(part.index);
              if (call !== undefined) {
                call.arguments += part.arguments;
                send(frames.toolCallArgumentsDelta(part.arguments));
              }
              break;
            }
            case 'tool-call':
              // A provider that never streamed fragments: the call arrives
              // whole, so its block opens and its arguments land together.
              calls.set(part.index, {
                id: part.id,
                name: part.name,
                arguments: part.arguments,
              });
              send(frames.toolCallStart(part.id, part.name));
              if (part.arguments !== '') send(frames.toolCallArgumentsDelta(part.arguments));
              break;
          }
        }

        const done = await handle.completion;

        // Anthropic requires every opened block to close before message_delta.
        send(frames.closeBlock());
        send(frames.delta({ finishReason: done.finishReason, usage: done.usage }));
        send(frames.stop());
      } catch (err) {
        // The 200 is long gone, so the only way to report this is in-band, as
        // the `error` event an Anthropic client watches for.
        log.warn('messages.stream_interrupted', {
          detail: err instanceof Error ? err.message : String(err),
        });
        send(frames.closeBlock());
        send(
          frames.error(
            // Reuses the OpenAI body only as a carrier for the message; the
            // frame itself is Anthropic-shaped.
            {
              error: {
                message: 'the upstream stream ended early',
                type: 'api_error',
                param: null,
                code: 'internal_error',
                request_id: requestId,
              },
            },
          ),
        );
      } finally {
        // The Messages protocol has no `[DONE]` sentinel: `message_stop` (or
        // `error`) ends the stream.
        controller.close();
        // Keeps the serverless invocation alive until the ledger is settled.
        await billing;
      }
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

async function handlePost(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: 'v1.messages' });
  const startedAt = Date.now();
  log.info('messages.start');

  try {
    const auth = await authenticateApiKey(readAuthHeader(req), log);
    requireScope(auth, SCOPE);
    await admitGeneration(auth.ownerId);

    const limit = await consumeRateLimit(auth.apiKeyId, auth.rateLimitRpm);
    if (!limit.allowed) {
      log.warn('messages.rate_limited', { retry_after: limit.retryAfterSeconds });
      return anthropicError('rate_limited', 'rate limit exceeded', requestId, 429, {
        'Retry-After': String(limit.retryAfterSeconds),
      });
    }

    const body = await parseBody(req);

    // A stream is not a storable `{status, body}` pair, so it takes no part in
    // idempotent replay. No Anthropic SDK sends an Idempotency-Key on a
    // streaming call, so nothing is lost in practice.
    if (body.stream === true) {
      const response = await runMessageStream({ requestId, auth, body, log });
      log.info('messages.end', { status: response.status, streaming: true });
      return response;
    }

    const idempotencyKey = readIdempotencyKey(req);
    const hash = messagesRequestHash(body);

    const outcome = await withIdempotency(auth.ownerId, idempotencyKey, hash, () =>
      runMessage({ requestId, auth, body, log }),
    );

    log.info('messages.end', {
      status: outcome.status,
      latency_ms: Date.now() - startedAt,
      replay: outcome.replay,
    });
    return Response.json(outcome.body, {
      status: outcome.status,
      headers: outcome.replay ? { 'Idempotency-Replay': 'true' } : undefined,
    });
  } catch (err) {
    // Classified for the log as well as the response: a provider outage
    // logged at error level charges their downtime to our error budget and
    // buries the genuine bugs it is meant to surface.
    const classified = err instanceof ApiError ? err : asUpstreamError(err);
    if (classified !== null) {
      log.warn('messages.error', {
        code: classified.code,
        latency_ms: Date.now() - startedAt,
        ...(err instanceof ApiError
          ? {}
          : { upstream: err instanceof Error ? err.message : String(err) }),
      });
    } else {
      log.error('messages.unexpected', {
        latency_ms: Date.now() - startedAt,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return anthropicErrorFrom(err, requestId);
  }
}

export const POST = guardedRoute(handlePost, anthropicErrorFrom);
