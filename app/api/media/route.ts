import { guardedRoute, admitGeneration } from '@/lib/guardrails/runtime';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { dashboardErrorFrom } from '@/lib/api/dashboard-errors';
import { ApiError } from '@/lib/api/errors';
import { loadPlan } from '@/lib/chat/pipeline';
import { createMediaJob, mediaMarker } from '@/lib/media/jobs';
import { mediaAvailability } from '@/lib/media/availability';
import { logger } from '@/lib/log';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Dashboard-side media generation, used by the chat workspace.
 *
 * The session sibling of `/v1/images` and `/v1/videos`: same pipeline, same
 * hold-and-settle, but identity comes from the Supabase session rather than an
 * API key, so the browser never needs one. Nothing here is billed differently
 * — a render costs the same credits from either door.
 *
 * On success the job is recorded as an assistant turn carrying a marker rather
 * than a URL. Signed URLs expire, so a stored one would render a broken image
 * a day later; the marker lets the client mint a fresh URL every time the
 * conversation is opened.
 */

export const runtime = 'nodejs';
export const maxDuration = 300;

const requestSchema = z.object({
  conversationId: z.uuid().optional(),
  kind: z.enum(['image', 'video']),
  model: z.string().min(1).max(128),
  prompt: z.string().trim().min(1).max(5000),
});

async function handlePost(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: 'dashboard.media' });

  try {
    // Session identity comes from Supabase verification, never a submitted id.
    const session = await createClient();
    const { data: userData, error: userError } = await session.auth.getUser();
    if (userError !== null || userData.user === null) {
      throw new ApiError('unauthorized', 'sign in to generate media', 401);
    }
    const userId = userData.user.id;
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== new URL(request.url).origin) throw new ApiError('forbidden', 'Invalid request origin.', 403);

    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      throw new ApiError(
        'invalid_request',
        field === 'prompt' ? 'Image and video prompts can be up to 5,000 characters.'
          : field === 'model' ? 'Choose a model.' : 'Reload the page and try again.',
        400,
      );
    }
    const availability = mediaAvailability(parsed.data.kind);
    if (!availability.enabled) {
      throw new ApiError('channel_unavailable', availability.reason ?? `${parsed.data.kind} generation is unavailable`, 503);
    }
    await admitGeneration(userId);

    const service = createServiceClient();
    let conversationId = parsed.data.conversationId ?? null;

    if (conversationId === null) {
      const { data, error } = await service
        .from('chat_conversations')
        .insert({
          user_id: userId,
          title: parsed.data.prompt.slice(0, 60),
          model: parsed.data.model,
        })
        .select('id')
        .single();
      if (error !== null) {
        throw new ApiError('internal_error', 'could not start a conversation', 500);
      }
      conversationId = z.object({ id: z.string() }).parse(data).id;
    } else {
      // Ownership is checked against the session user, not assumed from the id.
      const { data } = await service
        .from('chat_conversations')
        .select('id')
        .eq('id', conversationId)
        .eq('user_id', userId)
        .maybeSingle();
      if (data === null) {
        throw new ApiError('not_found', 'no such conversation', 404);
      }
    }

    const plan = await loadPlan(userId);
    const job = await createMediaJob({
      userId,
      apiKeyId: null,
      publicModelId: parsed.data.model,
      kind: parsed.data.kind,
      conversationId,
      input: { prompt: parsed.data.prompt },
      planKey: plan.key,
      log,
    });

    // The prompt is the user's turn; the marker is the assistant's.
    await service.from('chat_messages').insert([
      {
        conversation_id: conversationId,
        role: 'user',
        content: parsed.data.prompt,
        model: parsed.data.model,
      },
      {
        conversation_id: conversationId,
        role: 'assistant',
        content: mediaMarker(job.id),
        model: parsed.data.model,
      },
    ]);
    await service
      .from('chat_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId);

    log.info('media_job.created', { job_id: job.id, kind: job.kind, via: 'dashboard' });

    return Response.json(
      { id: job.id, kind: job.kind, status: job.status, conversation_id: conversationId },
      { status: 202, headers: { 'x-conversation-id': conversationId } },
    );
  } catch (err) {
    if (!(err instanceof ApiError)) {
      log.error('media_job.dashboard_failed', {
        reason: err instanceof Error ? err.message : 'unknown error',
      });
    }
    return dashboardErrorFrom(err, requestId);
  }
}

export const POST = guardedRoute(handlePost, dashboardErrorFrom);
