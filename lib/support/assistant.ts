import { randomUUID } from 'node:crypto';

import { cheapestChatModels, listPublicModels, selectChatRoute } from '@/lib/ai/channels';
import { costUsd } from '@/lib/ai/pricing';
import { resolvePlatformCreds } from '@/lib/admin/credentials';
import { ApiError } from '@/lib/api/errors';
import { generateChat } from '@/lib/chat/generate';
import type { ChatMessage } from '@/lib/chat/request';
import { loadPlan, roundCost } from '@/lib/chat/pipeline';
import { sql } from '@/lib/db';
import type { Logger } from '@/lib/log';
import { SITE_URL } from '@/lib/site-config';
import { supportSystemPrompt, type SupportContext } from './knowledge';
import type { SupportChatTurn } from './types';

/**
 * The support assistant: a platform-paid chat on the cheapest model, primed
 * with the setup guide and the customer's own account state.
 *
 * It never touches the customer's credits, keys or routing preferences, and it
 * never runs on their BYOK credentials: it is our cost, bounded by the limits
 * below rather than by a balance.
 */

/** Turns of history sent back to the model. Older turns only cost tokens. */
const HISTORY_TURNS = 12;
const MAX_OUTPUT_TOKENS = 700;
/** Per-customer caps on questions, counted from stored turns. */
const HOURLY_LIMIT = Number(process.env.SUPPORT_CHAT_HOURLY_LIMIT) || 30;
const DAILY_LIMIT = Number(process.env.SUPPORT_CHAT_DAILY_LIMIT) || 100;
/** The shape a support call has: a long system prompt, a short answer. */
const CALL_SHAPE = { inputTokens: 3500, outputTokens: 350 };
const MODEL_CACHE_MS = 10 * 60 * 1000;

let cachedModels: { at: number; ids: string[] } | null = null;

/**
 * Models to try, cheapest first. `SUPPORT_CHAT_MODEL` pins one (comma-separate
 * several for a fallback order); otherwise the three cheapest live models are
 * re-chosen every ten minutes, so a price change or outage moves it along.
 */
async function candidateModels(): Promise<string[]> {
  const pinned = (process.env.SUPPORT_CHAT_MODEL ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (pinned.length > 0) return pinned;
  if (cachedModels !== null && Date.now() - cachedModels.at < MODEL_CACHE_MS) return cachedModels.ids;
  const ids = await cheapestChatModels(CALL_SHAPE, 3);
  cachedModels = { at: Date.now(), ids };
  return ids;
}

/** The session a customer's next message joins: their latest, or a new one. */
export async function currentSession(userId: string): Promise<string | null> {
  const [row] = await sql<{ session_id: string }[]>`
    SELECT session_id FROM support_chat_messages
    WHERE user_id = ${userId}
    ORDER BY created_at DESC, id DESC
    LIMIT 1`;
  return row?.session_id ?? null;
}

export async function loadSession(userId: string, sessionId: string): Promise<SupportChatTurn[]> {
  const rows = await sql<{ id: string; role: 'user' | 'assistant'; content: string; created_at: Date }[]>`
    SELECT id, role, content, created_at FROM support_chat_messages
    WHERE user_id = ${userId} AND session_id = ${sessionId}
    ORDER BY created_at, id
    LIMIT 200`;
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at.toISOString(),
  }));
}

async function enforceLimits(userId: string): Promise<void> {
  const [counts] = await sql<{ hour: number; day: number }[]>`
    SELECT
      count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour,
      count(*)::int AS day
    FROM support_chat_messages
    WHERE user_id = ${userId} AND role = 'user' AND created_at > now() - interval '1 day'`;
  if ((counts?.hour ?? 0) >= HOURLY_LIMIT || (counts?.day ?? 0) >= DAILY_LIMIT) {
    throw new ApiError(
      'rate_limited',
      'You have asked the assistant a lot of questions recently. Please wait a while, or press Contact support to reach a person.',
      429,
    );
  }
}

/** Account facts shared by the assistant prompt and ticket diagnostics. */
export interface AccountSnapshot {
  balanceCredits: number | null;
  activeKeys: number | null;
  recentFailures: SupportContext['recentFailures'];
}

/** Each part degrades to "unknown" on its own: a support answer beats none. */
export async function accountSnapshot(userId: string): Promise<AccountSnapshot> {
  const [balance, keys, failures] = await Promise.all([
    sql<{ balance: string }[]>`SELECT get_balance(${userId}::uuid)::text AS balance`
      .then(([row]) => (row ? Number(row.balance) : null))
      .catch(() => null),
    sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM api_keys
      WHERE owner_id = ${userId} AND status = 'active' AND (expires_at IS NULL OR expires_at > now())`
      .then(([row]) => row?.count ?? 0)
      .catch(() => null),
    sql<{ request_id: string; error_code: string | null; created_at: Date }[]>`
      SELECT request_id, error_code, created_at FROM usage_events
      WHERE user_id = ${userId} AND status IN ('failed', 'rejected')
      ORDER BY created_at DESC LIMIT 5`
      .then((rows) =>
        rows.map((row) => ({
          requestId: row.request_id,
          errorCode: row.error_code,
          at: row.created_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
        })),
      )
      .catch(() => []),
  ]);
  return { balanceCredits: balance, activeKeys: keys, recentFailures: failures };
}

async function customerContext(userId: string, planKey: string): Promise<SupportContext> {
  const [snapshot, models] = await Promise.all([
    accountSnapshot(userId),
    listPublicModels(planKey).catch(() => [] as string[]),
  ]);
  return { siteUrl: SITE_URL, plan: planKey, models, ...snapshot };
}

export interface AssistantReply {
  sessionId: string;
  question: SupportChatTurn;
  answer: SupportChatTurn;
}

/**
 * Answers one customer question and stores both turns. The question is only
 * saved once an answer exists, so a failed call leaves no orphan turn and does
 * not count against the customer's limit.
 */
export async function askAssistant(
  userId: string,
  content: string,
  sessionId: string | null,
  log: Logger,
): Promise<AssistantReply> {
  await enforceLimits(userId);
  // No session id means the customer asked for a fresh conversation.
  const session = sessionId ?? randomUUID();
  const history = sessionId === null ? [] : await loadSession(userId, sessionId);
  const { key: planKey } = await loadPlan(userId);
  const context = await customerContext(userId, planKey);

  const messages: ChatMessage[] = [
    { role: 'system', content: supportSystemPrompt(context) },
    ...history.slice(-HISTORY_TURNS).map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content },
  ];

  const models = await candidateModels();
  if (models.length === 0) {
    throw new ApiError('channel_unavailable', 'The assistant is unavailable right now. Press Contact support to reach a person.', 503);
  }

  let lastError: unknown = null;
  for (const model of models) {
    // Plan 'max' because the platform pays: a model's plan minimum limits what
    // customers may buy, not what our own assistant may run on.
    const route = await selectChatRoute(model, 'max');
    if (route === null) continue;
    try {
      const result = await generateChat({
        start: route.start,
        resolve: route.resolve,
        buildCreds: (channel) => resolvePlatformCreds(channel.provider, channel.baseUrl),
        messages,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2,
      });
      const cost = roundCost(costUsd(result.rates, result.usage));
      const answerText = result.content.trim().slice(0, 20000);
      const [question, answer] = await sql.begin(async (tx) => {
        const [q] = await tx<{ id: string; created_at: Date }[]>`
          INSERT INTO support_chat_messages (user_id, session_id, role, content)
          VALUES (${userId}, ${session}, 'user', ${content})
          RETURNING id, created_at`;
        const [a] = await tx<{ id: string; created_at: Date }[]>`
          INSERT INTO support_chat_messages
            (user_id, session_id, role, content, model, input_tokens, output_tokens, cost_usd, created_at)
          VALUES (${userId}, ${session}, 'assistant', ${answerText}, ${model},
            ${result.usage.inputTokens + result.usage.cachedTokens}, ${result.usage.outputTokens}, ${cost},
            clock_timestamp())
          RETURNING id, created_at`;
        return [q!, a!];
      });
      log.info('support.assistant_answered', {
        model,
        channel_id: result.channelId,
        latency_ms: result.latencyMs,
        cost_usd: cost,
      });
      return {
        sessionId: session,
        question: { id: question.id, role: 'user', content, createdAt: question.created_at.toISOString() },
        answer: { id: answer.id, role: 'assistant', content: answerText, createdAt: answer.created_at.toISOString() },
      };
    } catch (error) {
      lastError = error;
      log.warn('support.assistant_model_failed', {
        model,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    }
  }
  if (lastError !== null) cachedModels = null;
  throw new ApiError(
    'generation_failed',
    'The assistant could not answer just now. Try again, or press Contact support to reach a person.',
    502,
  );
}
