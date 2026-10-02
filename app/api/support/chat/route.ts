import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { ApiError } from '@/lib/api/errors';
import { requestOriginMatches } from '@/lib/api/request-origin';
import { logger } from '@/lib/log';
import { askAssistant } from '@/lib/support/assistant';
import { CHAT_MESSAGE_MAX } from '@/lib/support/types';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 120;

const bodySchema = z.object({
  content: z.string().trim().min(1).max(CHAT_MESSAGE_MAX),
  /** Null starts a new conversation. */
  sessionId: z.uuid().nullable(),
});

/**
 * One question to the support assistant. Session-authenticated and free to the
 * customer; the per-customer caps live in askAssistant.
 */
export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: 'support.chat' });
  try {
    if (!requestOriginMatches(request)) throw new ApiError('forbidden', 'Invalid request origin.', 403);
    const session = await createClient();
    const { data, error } = await session.auth.getUser();
    if (error || !data.user) throw new ApiError('unauthorized', 'Sign in to use the assistant.', 401);

    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      throw new ApiError('invalid_request', `Enter a question of up to ${CHAT_MESSAGE_MAX.toLocaleString('en-US')} characters.`, 400);
    }
    const reply = await askAssistant(data.user.id, body.data.content, body.data.sessionId, log);
    return Response.json(reply);
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json({ error: { message: error.message, request_id: requestId } }, { status: error.status });
    }
    log.error('support.chat_failed', { error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' });
    return Response.json(
      { error: { message: 'Something went wrong. Try again, or press Contact support to reach a person.', request_id: requestId } },
      { status: 500 },
    );
  }
}
