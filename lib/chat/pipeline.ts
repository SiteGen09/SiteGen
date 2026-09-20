import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { loadRoutingPreferences } from '@/lib/ai/sources';
import { resolveChannel, selectChannelByModel } from '@/lib/ai/channels';
import type { ChannelRow } from '@/lib/ai/fallback';
import { costUsd, creditsForUsage, type TokenRates } from '@/lib/ai/pricing';
import type { ProviderCreds } from '@/lib/ai/provider';
import type { AuthenticatedKey } from '@/lib/api/api-key-auth';
import { ApiError, type ErrorCode } from '@/lib/api/errors';
import { openAiErrorBody } from '@/lib/api/openai-errors';
import {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  type IdempotentResponse,
} from '@/lib/api/idempotency';
import { resolvePlatformCreds } from '@/lib/admin/credentials';
import { getPlans, isPlanKey, type PlanKey } from '@/lib/billing/plans';
import type { ChatMessage, ChatTool } from '@/lib/chat/request';
import { totalMessageChars, totalToolChars } from '@/lib/chat/request';
import { moderationText } from '@/lib/chat/tools';
import { getUserCredential } from '@/lib/generate/credentials';
import { estimateChatHoldCredits } from '@/lib/generate/estimate';
import {
  holdCredits,
  releaseCredits,
  settleCredits,
} from '@/lib/generate/ledger';
import type { NormalizedUsage } from '@/lib/generate/usage';
import { checkContent } from '@/lib/moderation/check';
import { recordStrikeAndMaybeSuspend } from '@/lib/moderation/strikes';
import type { Logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  // Nginx and friends buffer by default, which would defeat the point.
  'x-accel-buffering': 'no',
} as const;

/** Rounds a USD cost to the `numeric(12,6)` column's scale. */
export function roundCost(cost: number): number {
  return Number(cost.toFixed(6));
}

/** OpenAI-shaped error as an idempotent `{status, body}` pair. */
export function errorResponse(
  code: ErrorCode,
  message: string,
  requestId: string,
  status: number,
): IdempotentResponse {
  return { status, body: openAiErrorBody(code, message, requestId) };
}

/**
 * Idempotency is optional for chat: no OpenAI SDK sends an `Idempotency-Key`, so
 * one is generated server-side when the header is absent. `/v1/generate` keeps
 * its strict requirement. A present key that is too long is rejected.
 */
export function readIdempotencyKey(req: Request): string {
  const key = req.headers.get('idempotency-key');
  if (key === null || key.length === 0) return randomUUID();
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ApiError(
      'invalid_request',
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      400,
    );
  }
  return key;
}

export async function loadPlan(userId: string): Promise<{ key: PlanKey; maxOutputTokens: number }> {
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
  const key: PlanKey = parsed !== null && isPlanKey(parsed.plan_key) ? parsed.plan_key : 'free';
  return { key, maxOutputTokens: getPlans()[key].maxOutputTokens };
}

export interface ResolvedChannel {
  start: ChannelRow;
  resolve: (id: string) => Promise<ChannelRow | null>;
  buildCreds: (channel: ChannelRow) => Promise<ProviderCreds>;
}

/**
 * Chooses the channel and credentials for this call.
 *
 * A user with an active BYOK credential matching the channel provider runs on
 * their own key with the fallback walker disabled, so a BYOK call never spills
 * onto a billed platform channel. Absent BYOK the platform credential is
 * resolved per channel.
 */
export async function resolveChannelAndCreds(
  publicModelId: string,
  userId: string,
  planKey: string,
): Promise<ResolvedChannel | null> {
  const preferences = await loadRoutingPreferences(userId);
  const channel = await selectChannelByModel(publicModelId, planKey, preferences);
  if (channel === null) return null;

  const userCred = await getUserCredential(userId);
  if (userCred !== null && userCred.provider === channel.provider) {
    return { start: channel, resolve: async () => null, buildCreds: async () => userCred };
  }

  return {
    start: channel,
    resolve: resolveChannel,
    buildCreds: (c) => resolvePlatformCreds(c.provider, c.baseUrl),
  };
}

export interface UsageEventInput {
  requestId: string;
  userId: string;
  apiKeyId: string;
  channelId: string | null;
  status: 'ok' | 'failed' | 'rejected';
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  costUsd: number | null;
  creditsCharged: number | null;
  log: Logger;
}

/** Records the outcome of a call; a failed audit write must not mask the result. */
export async function recordUsageEvent(input: UsageEventInput): Promise<void> {
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

/** Protocol-agnostic preflight input. `maxOutputField` only names the wire field in the refusal message. */
export interface PreflightInput {
  requestId: string;
  auth: AuthenticatedKey;
  log: Logger;
  model: string;
  messages: ChatMessage[];
  tools?: readonly ChatTool[] | undefined;
  maxOutputTokens?: number | undefined;
  maxOutputField: string;
}

export type Preflight =
  | { ok: false; response: IdempotentResponse }
  | {
      ok: true;
      plan: { key: PlanKey; maxOutputTokens: number };
      resolved: ResolvedChannel;
      requestedMax: number;
      held: boolean;
    };

function failure(response: IdempotentResponse): Preflight {
  return { ok: false, response };
}

/**
 * Everything that must succeed before a single upstream token is requested:
 * plan ceiling, moderation, channel resolution and the credit hold.
 *
 * Shared by the buffered and streaming paths so the two cannot drift on who
 * gets rejected or what gets billed. It matters most for streaming: once the
 * response has started, the status code is already sent, so every refusal has
 * to happen here where a plain JSON error is still possible.
 */
export async function prepareCall(input: PreflightInput): Promise<Preflight> {
  const { requestId, auth, log, model, messages, tools, maxOutputTokens, maxOutputField } = input;
  const plan = await loadPlan(auth.ownerId);

  // Enforce the plan's output ceiling — reject, never clamp.
  const requestedMax = maxOutputTokens ?? plan.maxOutputTokens;
  if (requestedMax > plan.maxOutputTokens) {
    return failure(errorResponse(
      'invalid_request',
      `${maxOutputField} ${requestedMax} exceeds the ${plan.key} plan limit of ${plan.maxOutputTokens}`,
      requestId,
      400,
    ));
  }

  // Moderation — before any upstream call, so a flagged prompt is never billed.
  const prompt = moderationText(messages);
  const moderation = await checkContent(prompt, log);
  if (moderation.flagged) {
    await recordUsageEvent({
      requestId,
      userId: auth.ownerId,
      apiKeyId: auth.apiKeyId,
      channelId: null,
      status: 'rejected',
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      costUsd: null,
      creditsCharged: 0,
      log,
    });
    try {
      await recordStrikeAndMaybeSuspend(auth.ownerId, requestId, moderation.categories, log);
    } catch (err) {
      // A strike-bookkeeping failure must not change the caller's outcome.
      log.error('abuse.strike_failed', {
        alert: true,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return failure(errorResponse(
      'content_policy_violation',
      'the prompt was flagged by content moderation',
      requestId,
      400,
    ));
  }

  // Resolve the channel by public model name.
  const resolved = await resolveChannelAndCreds(model, auth.ownerId, plan.key);
  if (resolved === null) {
    return failure(
      errorResponse('model_not_found', `the model '${model}' does not exist`, requestId, 404),
    );
  }

  // Dynamic hold sized from the messages, the client's tool schemas and the
  // effective output ceiling. Tool definitions are prompt input the caller is
  // billed for, so the hold has to cover them too.
  const estimated = estimateChatHoldCredits(
    resolved.start,
    totalMessageChars(messages) + totalToolChars(tools),
    requestedMax,
  );
  let held = false;
  if (estimated > 0) {
    const hold = await holdCredits(auth.ownerId, requestId, estimated, resolved.start.id);
    if (!hold.success) {
      log.warn('chat.insufficient_credits', { required: estimated, balance: hold.balance });
      return failure(
        errorResponse(
          'insufficient_credits',
          `insufficient credits: need ${estimated}, balance ${hold.balance ?? 0}`,
          requestId,
          402,
        ),
      );
    }
    held = true;
  }

  return { ok: true, plan, resolved, requestedMax, held };
}

/** Settles the hold and writes the `ok` usage event. Returns what was charged. */
export interface SettleInput {
  requestId: string;
  auth: AuthenticatedKey;
  log: Logger;
  channelId: string;
  held: boolean;
  multiplier: number;
  rates: TokenRates;
  usage: NormalizedUsage;
  latencyMs: number;
}

export async function settleCall(input: SettleInput): Promise<{ creditsCharged: number; costUsd: number }> {
  const cost = costUsd(input.rates, input.usage);
  let creditsCharged = 0;
  if (input.held) {
    creditsCharged = creditsForUsage(cost, input.multiplier);
    await settleCredits(input.requestId, creditsCharged, {
      input_tokens: input.usage.inputTokens,
      output_tokens: input.usage.outputTokens,
      cached_tokens: input.usage.cachedTokens,
    });
  }

  await recordUsageEvent({
    requestId: input.requestId,
    userId: input.auth.ownerId,
    apiKeyId: input.auth.apiKeyId,
    channelId: input.channelId,
    status: 'ok',
    latencyMs: input.latencyMs,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cachedTokens: input.usage.cachedTokens,
    costUsd: roundCost(cost),
    creditsCharged,
    log: input.log,
  });

  return { creditsCharged, costUsd: cost };
}

/** Releases any hold and writes the `failed` usage event. */
export async function recordCallFailure(input: {
  requestId: string;
  auth: AuthenticatedKey;
  log: Logger;
  channelId: string | null;
  held: boolean;
}): Promise<void> {
  if (input.held) await releaseCredits(input.requestId);
  await recordUsageEvent({
    requestId: input.requestId,
    userId: input.auth.ownerId,
    apiKeyId: input.auth.apiKeyId,
    channelId: input.channelId,
    status: 'failed',
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    costUsd: null,
    creditsCharged: 0,
    log: input.log,
  });
}
