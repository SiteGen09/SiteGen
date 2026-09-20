import { randomUUID } from 'node:crypto';

import { authenticateApiKey, requireScope, type AuthenticatedKey } from '@/lib/api/api-key-auth';
import { ApiError } from '@/lib/api/errors';
import { openAiErrorFrom, openAiError, openAiErrorBody } from '@/lib/api/openai-errors';
import { withIdempotency, type IdempotentResponse } from '@/lib/api/idempotency';
import { generateChat } from '@/lib/chat/generate';
import { streamChat, type ChatStreamHandle } from '@/lib/chat/stream';
import type { ChatMessage, ChatTool } from '@/lib/chat/request';
import type { OpenAiToolCall } from '@/lib/chat/tools';
import {
  SSE_HEADERS,
  readIdempotencyKey,
  prepareCall,
  settleCall,
  recordCallFailure,
  type Preflight,
} from '@/lib/chat/pipeline';
import {
  responsesRequestSchema,
  responsesRequestHash,
  toChatMessages,
  toChatTools,
  toChatToolChoice,
  type ResponsesRequest,
} from '@/lib/responses/request';
import { createResponseFrames, responseObject } from '@/lib/responses/response';
import { consumeRateLimit, getBalance } from '@/lib/generate/ledger';
import type { Logger } from '@/lib/log';
import { logger } from '@/lib/log';

const SCOPE = 'chat' as const;

interface ResponseContext {
  requestId: string;
  auth: AuthenticatedKey;
  body: ResponsesRequest;
  log: Logger;
}

/** Parses the body without rejecting unknown fields. */
async function parseBody(req: Request): Promise<ResponsesRequest> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError('invalid_request', 'request body must be valid JSON', 400);
  }

  const parsed = responsesRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    const message = issue !== undefined ? `${where}${issue.message}` : 'invalid request body';
    throw new ApiError('invalid_request', message, 400);
  }

  return parsed.data;
}

/**
 * Preflight plus the translated chat form of the request. The translation is
 * done once and handed back so preflight and the upstream call can never see
 * different content: the hold is sized from exactly what gets sent.
 */
interface PreparedResponse {
  preflight: Preflight;
  messages: ChatMessage[];
  tools: ChatTool[] | undefined;
}

async function prepareResponse(ctx: ResponseContext): Promise<PreparedResponse> {
  const messages = toChatMessages(ctx.body);
  const tools = toChatTools(ctx.body);

  const preflight = await prepareCall({
    requestId: ctx.requestId,
    auth: ctx.auth,
    log: ctx.log,
    model: ctx.body.model,
    messages,
    tools,
    maxOutputTokens: ctx.body.max_output_tokens,
    maxOutputField: 'max_output_tokens',
  });

  return { preflight, messages, tools };
}

/**
 * Runs one priced response and returns the value to persist for the
 * idempotency key. Expected non-success outcomes (ceiling exceeded, flagged
 * content, no model, insufficient credits) are returned as their own stored
 * response; unexpected failures throw and are mapped by the caller.
 */
async function runResponse(ctx: ResponseContext): Promise<IdempotentResponse> {
  const { requestId, auth, body, log } = ctx;

  const { preflight, messages, tools } = await prepareResponse(ctx);
  if (!preflight.ok) return preflight.response;
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
      rates: generation.rates,
      usage: generation.usage,
      latencyMs: generation.latencyMs,
    });

    const balanceAfter = await getBalance(auth.ownerId);

    log.info('responses.ok', {
      channel_id: generation.channelId,
      latency_ms: generation.latencyMs,
      credits_charged: settled.creditsCharged,
      balance_after: balanceAfter,
    });

    // A finished Responses object is `incomplete` only when the model was cut
    // off; a tool-call turn is a complete answer despite carrying no text.
    const cutOff =
      generation.finishReason === 'length' || generation.finishReason === 'content-filter';

    // The PUBLIC model name is echoed, never the upstream model_id.
    return {
      status: 200,
      body: responseObject({
        requestId,
        model: body.model,
        createdAt: Math.floor(Date.now() / 1000),
        status: cutOff ? 'incomplete' : 'completed',
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
  /** A one-shot `tool-call` part already emitted its done frame. */
  done: boolean;
}

/**
 * Streams one priced response as Responses-shaped SSE.
 *
 * Coding harnesses keep this connection open for the whole turn, which changes
 * two things about billing. Every refusal has to happen in `prepareResponse`,
 * before the 200 is committed; and settlement can only run once the upstream
 * stream ends, so it is attached to the completion promise rather than to the
 * response body — a client that hangs up mid-turn has still consumed the
 * tokens, and is still charged for them.
 */
async function runResponseStream(ctx: ResponseContext): Promise<Response> {
  const { requestId, auth, body, log } = ctx;

  const { preflight, messages, tools } = await prepareResponse(ctx);
  if (!preflight.ok) {
    return Response.json(preflight.response.body, { status: preflight.response.status });
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

  // Settlement is deliberately not part of the response body: if the client
  // disconnects, this still runs to completion.
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
        rates: handle.channel.rates,
        usage: done.usage,
        latencyMs: done.latencyMs,
      });
      log.info('responses.stream_ok', {
        channel_id: handle.channel.id,
        latency_ms: done.latencyMs,
        credits_charged: settled.creditsCharged,
      });
    } catch (err) {
      log.error('responses.stream_failed', {
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
  const createdAt = Math.floor(Date.now() / 1000);
  const frames = createResponseFrames({ requestId, model: body.model, createdAt });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string): void => controller.enqueue(encoder.encode(text));
      try {
        send(frames.created());

        let content = '';
        // `tool-call-delta` carries only an index, so the id and name seen on
        // the opening part have to be remembered to address later frames, and
        // the fragments joined for the terminal `completed` snapshot.
        const calls = new Map<number, StreamingToolCall>();

        for await (const part of handle.partStream) {
          switch (part.type) {
            case 'text':
              content += part.text;
              send(frames.textDelta(part.text));
              break;
            case 'tool-call-start':
              calls.set(part.index, {
                id: part.id,
                name: part.name,
                arguments: '',
                done: false,
              });
              send(frames.functionCallAdded(part.index, part.id, part.name));
              break;
            case 'tool-call-delta': {
              const call = calls.get(part.index);
              if (call !== undefined) {
                call.arguments += part.arguments;
                send(frames.functionCallArgumentsDelta(part.index, call.id, part.arguments));
              }
              break;
            }
            case 'tool-call':
              // A provider that never streamed fragments: the call arrives
              // whole, so its added and done frames are emitted back to back.
              calls.set(part.index, {
                id: part.id,
                name: part.name,
                arguments: part.arguments,
                done: true,
              });
              send(frames.functionCallAdded(part.index, part.id, part.name));
              send(frames.functionCallDone(part.index, part.id, part.name, part.arguments));
              break;
          }
        }

        const done = await handle.completion;

        for (const [index, call] of calls) {
          if (!call.done) {
            send(frames.functionCallDone(index, call.id, call.name, call.arguments));
          }
        }

        const toolCalls: OpenAiToolCall[] = [...calls.values()].map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }));

        send(
          frames.completed({
            content,
            toolCalls,
            finishReason: done.finishReason,
            usage: done.usage,
          }),
        );
      } catch (err) {
        // The 200 is long gone, so the only way to report this is in-band —
        // the terminal event a Responses client looks for when a stream dies.
        log.warn('responses.stream_interrupted', {
          detail: err instanceof Error ? err.message : String(err),
        });
        send(
          frames.failed(
            openAiErrorBody('internal_error', 'the upstream stream ended early', requestId),
          ),
        );
      } finally {
        // Unlike chat completions, the Responses protocol has no `[DONE]`
        // sentinel: `response.completed` / `response.failed` ends the stream.
        controller.close();
        // Keeps the serverless invocation alive until the ledger is settled.
        await billing;
      }
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: 'v1.responses' });
  const startedAt = Date.now();
  log.info('responses.start');

  try {
    const auth = await authenticateApiKey(req.headers.get('authorization'), log);
    requireScope(auth, SCOPE);

    const limit = await consumeRateLimit(auth.apiKeyId, auth.rateLimitRpm);
    if (!limit.allowed) {
      log.warn('responses.rate_limited', { retry_after: limit.retryAfterSeconds });
      return openAiError('rate_limited', 'rate limit exceeded', requestId, 429, {
        'Retry-After': String(limit.retryAfterSeconds),
      });
    }

    const body = await parseBody(req);

    // A stream is not a storable `{status, body}` pair, so it does not take
    // part in idempotent replay. No OpenAI SDK sends an Idempotency-Key on a
    // streaming call, so nothing is lost in practice.
    if (body.stream === true) {
      const response = await runResponseStream({ requestId, auth, body, log });
      log.info('responses.end', { status: response.status, streaming: true });
      return response;
    }

    const idempotencyKey = readIdempotencyKey(req);
    const hash = responsesRequestHash(body);

    const outcome = await withIdempotency(auth.ownerId, idempotencyKey, hash, () =>
      runResponse({ requestId, auth, body, log }),
    );

    log.info('responses.end', {
      status: outcome.status,
      latency_ms: Date.now() - startedAt,
      replay: outcome.replay,
    });
    return Response.json(outcome.body, {
      status: outcome.status,
      headers: outcome.replay ? { 'Idempotency-Replay': 'true' } : undefined,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      log.warn('responses.error', { code: err.code, latency_ms: Date.now() - startedAt });
    } else {
      log.error('responses.unexpected', {
        latency_ms: Date.now() - startedAt,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return openAiErrorFrom(err, requestId);
  }
}
