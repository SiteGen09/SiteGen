import { enforceLocalPolicy } from '@/lib/guardrails/runtime';
import { policyText } from '@/lib/guardrails/policy';
import { guardedRoute, admitGeneration } from '@/lib/guardrails/runtime';
import { z } from 'zod';

import { selectByokChannel, selectChannel, resolveChannel } from '@/lib/ai/channels';
import type { ChannelRow } from '@/lib/ai/fallback';
import { costUsd, creditsForUsage } from '@/lib/ai/pricing';
import type { ProviderCreds } from '@/lib/ai/provider';
import { authenticateApiKey, requireScope, type AuthenticatedKey } from '@/lib/api/api-key-auth';
import { asUpstreamError } from '@/lib/api/upstream';
import { ApiError, apiError } from '@/lib/api/errors';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  withIdempotency,
  type IdempotentResponse,
} from '@/lib/api/idempotency';
import { resolvePlatformCreds } from '@/lib/admin/credentials';
import { getUserCredential } from '@/lib/generate/credentials';
import { HOLD_BUDGET, estimateHoldCredits } from '@/lib/generate/estimate';
import { generateSpec } from '@/lib/generate/generate';
import {
  consumeRateLimit,
  getBalance,
  holdCredits,
  releaseCredits,
  settleCredits,
} from '@/lib/generate/ledger';
import { buildSpecPrompt } from '@/lib/generate/prompt';
import { generateRequestSchema, requestHash, type GenerateRequest } from '@/lib/generate/request';
import type { Logger } from '@/lib/log';
import { logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

const TASK = 'site.spec' as const;

/** Rounds a USD cost to the `numeric(12,6)` column's scale. */
function roundCost(cost: number): number {
  return Number(cost.toFixed(6));
}

async function loadPlanKey(userId: string): Promise<string> {
  const service = createServiceClient();
  const { data, error } = await service
    .from('entitlements')
    .select('plan_key')
    .eq('user_id', userId)
    .maybeSingle();

  if (error !== null) {
    throw new ApiError('internal_error', 'could not load entitlements', 500);
  }
  const parsed = z.object({ plan_key: z.string() }).nullable().parse(data);
  return parsed?.plan_key ?? 'free';
}

interface ResolvedChannel {
  start: ChannelRow;
  /** Fallback walker for the chosen channel's chain. */
  resolve: (id: string) => Promise<ChannelRow | null>;
  buildCreds: (channel: ChannelRow) => Promise<ProviderCreds>;
}

/**
 * Chooses the channel and credential source for this call.
 *
 * A user with active BYOK credentials runs on a zero-multiplier channel with
 * their decrypted key; the fallback resolver returns `null` so a BYOK call
 * never spills onto a platform channel that would bill without a hold. Absent
 * BYOK, the platform channel decrypts the shared credential (or the env key).
 */
async function resolveChannelAndCreds(
  userId: string,
  planKey: string,
): Promise<ResolvedChannel | null> {
  const userCred = await getUserCredential(userId);
  if (userCred !== null) {
    const byokChannel = await selectByokChannel(TASK, userCred.provider, planKey);
    if (byokChannel !== null) {
      // A BYOK call must never spill onto a platform channel that would bill
      // without a hold, so its chain is deliberately not walked.
      return { start: byokChannel, resolve: async () => null, buildCreds: async () => userCred };
    }
  }

  const platformChannel = await selectChannel(TASK, planKey);
  if (platformChannel === null) return null;

  return {
    start: platformChannel,
    resolve: resolveChannel,
    buildCreds: (channel) => resolvePlatformCreds(channel.provider, channel.baseUrl),
  };
}

interface UsageEventInput {
  requestId: string;
  userId: string;
  apiKeyId: string;
  channelId: string;
  status: 'ok' | 'failed' | 'rejected';
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  creditsCharged: number | null;
  log: Logger;
}

/**
 * Records the outcome of a call. A failure to write the audit row must not mask
 * the real result, so the error is logged and swallowed.
 */
async function recordUsageEvent(input: UsageEventInput): Promise<void> {
  const service = createServiceClient();
  const { error } = await service.from('usage_events').upsert({
    request_id: input.requestId,
    user_id: input.userId,
    api_key_id: input.apiKeyId,
    channel_id: input.channelId,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    cached_tokens: input.cachedTokens,
    latency_ms: input.latencyMs,
    status: input.status,
    cost_usd: input.costUsd,
    credits_charged: input.creditsCharged,
  });
  if (error !== null) {
    input.log.error('usage_event.write_failed', { db_error: error.code });
  }
}

interface GenerationContext {
  requestId: string;
  auth: AuthenticatedKey;
  body: GenerateRequest;
  log: Logger;
}

/**
 * Runs the priced generation and returns the response to persist for the
 * idempotency key. Expected non-success outcomes (no channel, insufficient
 * credits) are returned as their own status so they are stored; truly
 * unexpected failures throw and are handled by the caller.
 */
async function runGeneration(ctx: GenerationContext): Promise<IdempotentResponse> {
  const { requestId, auth, body, log } = ctx;
  await enforceLocalPolicy(policyText(body));
  const planKey = await loadPlanKey(auth.ownerId);

  const resolved = await resolveChannelAndCreds(auth.ownerId, planKey);
  if (resolved === null) {
    return {
      status: 503,
      body: {
        error: {
          code: 'channel_unavailable',
          message: 'no channel is available for this plan',
          request_id: requestId,
        },
      },
    };
  }

  const estimated = estimateHoldCredits(resolved.start);
  let held = false;
  if (estimated > 0) {
    const hold = await holdCredits(auth.ownerId, requestId, estimated, resolved.start.id);
    if (!hold.success) {
      log.warn('generate.insufficient_credits', { required: estimated, balance: hold.balance });
      return {
        status: 402,
        body: {
          error: {
            code: 'insufficient_credits',
            message: `insufficient credits: need ${estimated}, balance ${hold.balance ?? 0}`,
            request_id: requestId,
          },
        },
      };
    }
    held = true;
  }

  try {
    const generation = await generateSpec({
      start: resolved.start,
      resolve: resolved.resolve,
      buildCreds: resolved.buildCreds,
      prompt: buildSpecPrompt(body),
      maxOutputTokens: HOLD_BUDGET.outputTokens,
    });
    // Rates come from the serving channel, so an unpriced model is a channel
    // misconfiguration rather than a code lookup that can silently miss.
    const cost = costUsd(generation.rates, generation.usage);

    let creditsCharged = 0;
    if (held) {
      creditsCharged = creditsForUsage(cost ?? 0, generation.multiplier);
      await settleCredits(requestId, creditsCharged, {
        input_tokens: generation.usage.inputTokens,
        output_tokens: generation.usage.outputTokens,
        cached_tokens: generation.usage.cachedTokens,
      });
    }

    const balanceAfter = await getBalance(auth.ownerId);

    await recordUsageEvent({
      requestId,
      userId: auth.ownerId,
      apiKeyId: auth.apiKeyId,
      channelId: generation.channelId,
      status: 'ok',
      latencyMs: generation.latencyMs,
      inputTokens: generation.usage.inputTokens,
      outputTokens: generation.usage.outputTokens,
      cachedTokens: generation.usage.cachedTokens,
      costUsd: cost === null ? null : roundCost(cost),
      creditsCharged,
      log,
    });

    log.info('generate.ok', {
      channel_id: generation.channelId,
      latency_ms: generation.latencyMs,
      credits_charged: creditsCharged,
    });

    return {
      status: 200,
      body: {
        spec: generation.spec,
        usage: {
          request_id: requestId,
          channel_id: generation.channelId,
          input_tokens: generation.usage.inputTokens,
          output_tokens: generation.usage.outputTokens,
          cached_tokens: generation.usage.cachedTokens,
          latency_ms: generation.latencyMs,
          credits_charged: creditsCharged,
          balance_after: balanceAfter,
        },
      },
    };
  } catch (err) {
    if (held) await releaseCredits(requestId);
    await recordUsageEvent({
      requestId,
      userId: auth.ownerId,
      apiKeyId: auth.apiKeyId,
      channelId: resolved.start.id,
      status: 'failed',
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costUsd: null,
      creditsCharged: 0,
      log,
    });
    throw err;
  }
}

function readIdempotencyKey(req: Request, _requestId: string): string {
  const key = req.headers.get('idempotency-key');
  if (key === null || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ApiError(
      'invalid_request',
      `Idempotency-Key header is required and must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      400,
    );
  }
  return key;
}

async function parseBody(req: Request): Promise<GenerateRequest> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError('invalid_request', 'request body must be valid JSON', 400);
  }

  const parsed = generateRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    const message = issue !== undefined ? `${where}${issue.message}` : 'invalid request body';
    throw new ApiError('invalid_request', message, 400);
  }
  return parsed.data;
}

async function handlePost(req: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const log = logger({ request_id: requestId, route: 'v1.generate' });
  const startedAt = Date.now();
  log.info('generate.start');

  try {
    const auth = await authenticateApiKey(req.headers.get('authorization'), log);
    requireScope(auth, 'generate');
    await admitGeneration(auth.ownerId);

    const limit = await consumeRateLimit(auth.apiKeyId, auth.rateLimitRpm);
    if (!limit.allowed) {
      log.warn('generate.rate_limited', { retry_after: limit.retryAfterSeconds });
      return Response.json(
        {
          error: {
            code: 'rate_limited',
            message: 'rate limit exceeded',
            request_id: requestId,
          },
        },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } },
      );
    }

    const idempotencyKey = readIdempotencyKey(req, requestId);
    const body = await parseBody(req);
    const hash = requestHash(body);

    const outcome = await withIdempotency(auth.ownerId, idempotencyKey, hash, () =>
      runGeneration({ requestId, auth, body, log }),
    );

    log.info('generate.end', { status: outcome.status, latency_ms: Date.now() - startedAt, replay: outcome.replay });
    return Response.json(outcome.body, {
      status: outcome.status,
      headers: outcome.replay ? { 'Idempotency-Replay': 'true' } : undefined,
    });
  } catch (err) {
    if (err instanceof ApiError) {
      log.warn('generate.error', { code: err.code, latency_ms: Date.now() - startedAt });
      return apiError(err.code, err.message, requestId, err.status);
    }
    // A provider fault is not our fault; see `lib/api/upstream.ts`.
    const upstream = asUpstreamError(err);
    if (upstream !== null) {
      log.warn('generate.upstream', {
        code: upstream.code,
        latency_ms: Date.now() - startedAt,
        detail: err instanceof Error ? err.message : String(err),
      });
      return apiError(upstream.code, upstream.message, requestId, upstream.status);
    }
    log.error('generate.unexpected', {
      latency_ms: Date.now() - startedAt,
      detail: err instanceof Error ? err.message : String(err),
    });
    return apiError('internal_error', 'an unexpected error occurred', requestId, 500);
  }
}

function guardError(error: unknown, id: string): Response {
  return error instanceof ApiError ? apiError(error.code, error.message, id, error.status) : apiError('internal_error', 'request failed', id, 500);
}

export const POST = guardedRoute(handlePost, guardError);
