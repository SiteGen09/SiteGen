import { guardedRoute } from '@/lib/guardrails/runtime';
import { openAiErrorFrom } from '@/lib/api/openai-errors';
import { handleCreate } from '@/lib/media/handlers';

/** See `lib/media/handlers.ts`: both media endpoints share one implementation. */
export const runtime = 'nodejs';

async function handlePost(request: Request): Promise<Response> {
  return handleCreate(request, 'video');
}

export const POST = guardedRoute(handlePost, openAiErrorFrom);
