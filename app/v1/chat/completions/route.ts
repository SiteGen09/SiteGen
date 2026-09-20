import { randomUUID } from 'node:crypto';

import { authenticateApiKey, requireScope, type AuthenticatedKey } from '@/lib/api/api-key-auth';
import { ApiError } from '@/lib/api/errors';
import { openAiErrorFrom, openAiError, openAiErrorBody } from '@/lib/api/openai-errors';
import { withIdempotency, type IdempotentResponse } from '@/lib/api/idempotency';
import { generateChat } from '@/lib/chat/generate';
import { streamChat, type ChatStreamHandle } from '@/lib/chat/stream';
import {
  chatCompletionRequestSchema,
  chatRequestHash,
  type ChatCompletionRequest,
} from '@/lib/chat/request';
import { openAiFinishReason } from '@/lib/chat/tools';
import {
  SSE_HEADERS,
  readIdempotencyKey,
  prepareCall,
  settleCall,
  recordCallFailure,
  type Preflight,
} from '@/lib/chat/pipeline';
import { getBalance } from '@/lib/generate/ledger';
import { consumeRateLimit } from '@/lib/generate/ledger';
import type { Logger } from '@/lib/log';
import { logger } from '@/lib/log';

const SCOPE = 'chat' as const;

interface ChatContext {
  requestId: string;
  auth: AuthenticatedKey;
  body: ChatCompletionRequest;
  log: Logger;
}


/** Parses the body without rejecting unknown fields. */
async function parseBody(req: Request): Promise<ChatCompletionRequest> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError('invalid_request', 'request body must be valid JSON', 400);
  }

  const parsed = chatCompletionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    const message = issue !== undefined ? `${where}${issue.message}` : 'invalid request body';
    throw new ApiError('invalid_request', message, 400);
  }

  return parsed.data;
}


async function prepareChat(ctx: ChatContext): Promise<Preflight> {
  return prepareCall({
    requestId: ctx.requestId,
    auth: ctx.auth,
    log: ctx.log,
    model: ctx.body.model,
    messages: ctx.body.messages,
    tools: ctx.body.tools,
    maxOutputTokens: ctx.body.max_tokens,
    maxOutputField: 'max_tokens',
  });
}

/**
 * Runs one priced chat completion and returns the response to persist for the
 * idempotency key. Expected non-success outcomes (ceiling exceeded, flagged
 * content, no model, insufficient credits) are returned as their own stored
 * response; unexpected failures throw and are mapped by the caller.
 */
async function runChat(ctx: ChatContext): Promise<IdempotentResponse> {
  const { requestId, auth, body, log } = ctx;

  const prepared = await prepareChat(ctx);
  if (!prepared.ok) return prepared.response;
  const { resolved, requestedMax, held } = prepared;

  try {
    const generation = await generateChat({
      start: resolved.start,
      resolve: resolved.resolve,
      buildCreds: resolved.buildCreds,
      messages: body.messages,
      maxOutputTokens: requestedMax,
      temperature: body.temperature,
      topP: body.top_p,
      stop: body.stop,
      tools: body.tools,
      toolChoice: body.tool_choice,
    });

    const { creditsCharged } = await settleCall({
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

    log.info('chat.ok', {
      channel_id: generation.channelId,
      latency_ms: generation.latencyMs,
      credits_charged: creditsCharged,
      balance_after: balanceAfter,
    });


    // The PUBLIC model name is reported, never the upstream model_id.
    const hasToolCalls = generation.toolCalls.length > 0;
    const promptTokens = generation.usage.inputTokens + generation.usage.cachedTokens;
    const completionTokens = generation.usage.outputTokens;
    return {
      status: 200,
      body: {
        id: `chatcmpl-${requestId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              // A tool-call-only turn carries no text, and OpenAI reports that
              // as a null content rather than an empty string.
              content: hasToolCalls && generation.content === '' ? null : generation.content,
              ...(hasToolCalls ? { tool_calls: generation.toolCalls } : {}),
            },
            finish_reason: openAiFinishReason(generation.finishReason),
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      },
    };
  } catch (err) {
    await recordCallFailure({ requestId, auth, log, channelId: resolved.start.id, held });
    throw err;
  }
}



/**
 * Streams one priced chat completion as OpenAI-shaped SSE.
 *
 * Coding harnesses keep this connection open for the whole turn, which changes
 * two things about billing. Every refusal has to happen in `prepareChat`,
 * before the 200 is committed; and settlement can only run once the upstream
 * stream ends, so it is attached to the completion promise rather than to the
 * response body — a client that hangs up mid-turn has still consumed the
 * tokens, and is still charged for them.
 */
async function runChatStream(ctx: ChatContext): Promise<Response> {
  const { requestId, auth, body, log } = ctx;

  const prepared = await prepareChat(ctx);
  if (!prepared.ok) {
    return Response.json(prepared.response.body, { status: prepared.response.status });
  }
  const { resolved, requestedMax, held } = prepared;

  async function recordFailure(): Promise<void> {
    await recordCallFailure({ requestId, auth, log, channelId: resolved.start.id, held });
  }

  let handle: ChatStreamHandle;
  try {
    handle = await streamChat({
      start: resolved.start,
      resolve: resolved.resolve,
      buildCreds: resolved.buildCreds,
      messages: body.messages,
      maxOutputTokens: requestedMax,
      temperature: body.temperature,
      topP: body.top_p,
      stop: body.stop,
      tools: body.tools,
      toolChoice: body.tool_choice,
    });
  } catch (err) {
    // Nothing has been written yet, so this can still be a normal JSON error.
    await recordFailure();
    throw err;
  }

  // Settlement is deliberately not part of the response body: if the client
  // disconnects, this still runs to completion.
  const billing = (async () => {
    try {
      const done = await handle.completion;
      const { creditsCharged } = await settleCall({
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
      log.info('chat.stream_ok', {
        channel_id: handle.channel.id,
        latency_ms: done.latencyMs,
        credits_charged: creditsCharged,
      });
    } catch (err) {
      log.error('chat.stream_failed', {
        detail: err instanceof Error ? err.message : String(err),
      });
      await recordFailure().catch(() => undefined);
    }
  })();

  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const includeUsage = body.stream_options?.include_usage === true;

  /** One `chat.completion.chunk`. The PUBLIC model name is echoed, never the upstream id. */
  function envelope(choice: Record<string, unknown>, extra?: Record<string, unknown>): string {
    return `data: ${JSON.stringify({
      id: `chatcmpl-${requestId}`,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, ...choice }],
      ...extra,
    })}\n\n`;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string): void => controller.enqueue(encoder.encode(text));
      try {
        send(envelope({ delta: { role: 'assistant' }, finish_reason: null }));
        // OpenAI's streaming tool-call shape: the first fragment for an index
        // carries the id and function.name, later fragments only append to
        // function.arguments.
        for await (const part of handle.partStream) {
          switch (part.type) {
            case 'text':
              send(envelope({ delta: { content: part.text }, finish_reason: null }));
              break;
            case 'tool-call-start':
              send(
                envelope({
                  delta: {
                    tool_calls: [
                      {
                        index: part.index,
                        id: part.id,
                        type: 'function',
                        function: { name: part.name, arguments: '' },
                      },
                    ],
                  },
                  finish_reason: null,
                }),
              );
              break;
            case 'tool-call-delta':
              send(
                envelope({
                  delta: {
                    tool_calls: [{ index: part.index, function: { arguments: part.arguments } }],
                  },
                  finish_reason: null,
                }),
              );
              break;
            case 'tool-call':
              send(
                envelope({
                  delta: {
                    tool_calls: [
                      {
                        index: part.index,
                        id: part.id,
                        type: 'function',
                        function: { name: part.name, arguments: part.arguments },
                      },
                    ],
                  },
                  finish_reason: null,
                }),
              );
              break;
          }
        }

        const done = await handle.completion;
        const finishReason = openAiFinishReason(done.finishReason);
        send(envelope({ delta: {}, finish_reason: finishReason }));
        if (includeUsage) {
          const promptTokens = done.usage.inputTokens + done.usage.cachedTokens;
          send(
            envelope(
              { delta: {}, finish_reason: finishReason },
              {
                usage: {
                  prompt_tokens: promptTokens,
                  completion_tokens: done.usage.outputTokens,
                  total_tokens: promptTokens + done.usage.outputTokens,
                },
              },
            ),
          );
        }
      } catch (err) {
        // The 200 is long gone, so the only way to report this is in-band —
        // the shape OpenAI clients look for when a stream dies mid-flight.
        log.warn('chat.stream_interrupted', {
          detail: err instanceof Error ? err.message : String(err),
        });
        send(
          `data: ${JSON.stringify(
            openAiErrorBody('internal_error', 'the upstream stream ended early', requestId),
          )}\n\n`,
        );
      } finally {
        send('data: [DONE]\n\n');
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
  const log = logger({ request_id: requestId, route: 'v1.chat.completions' });
  const startedAt = Date.now();
  log.info('chat.start');

  try {
    const auth = await authenticateApiKey(req.headers.get('authorization'), log);
    requireScope(auth, SCOPE);

    const limit = await consumeRateLimit(auth.apiKeyId, auth.rateLimitRpm);
    if (!limit.allowed) {
      log.warn('chat.rate_limited', { retry_after: limit.retryAfterSeconds });
      return openAiError('rate_limited', 'rate limit exceeded', requestId, 429, {
        'Retry-After': String(limit.retryAfterSeconds),
      });
    }

    const body = await parseBody(req);

    // A stream is not a storable `{status, body}` pair, so it does not take
    // part in idempotent replay. No OpenAI SDK sends an Idempotency-Key on a
    // streaming call, so nothing is lost in practice.
    if (body.stream === true) {
      const response = await runChatStream({ requestId, auth, body, log });
      log.info('chat.end', { status: response.status, streaming: true });
      return response;
    }

    const idempotencyKey = readIdempotencyKey(req);
    const hash = chatRequestHash(body);

    const outcome = await withIdempotency(auth.ownerId, idempotencyKey, hash, () =>
      runChat({ requestId, auth, body, log }),
    );

    log.info('chat.end', {
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
      log.warn('chat.error', { code: err.code, latency_ms: Date.now() - startedAt });
    } else {
      log.error('chat.unexpected', {
        latency_ms: Date.now() - startedAt,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return openAiErrorFrom(err, requestId);
  }
}
