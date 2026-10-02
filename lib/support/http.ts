import type { User } from '@supabase/supabase-js';

import { ApiError } from '@/lib/api/errors';
import { requestOriginMatches } from '@/lib/api/request-origin';
import { boundedRequest } from '@/lib/guardrails/runtime';
import type { Logger } from '@/lib/log';
import { createClient } from '@/lib/supabase/server';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from './types';

/** Three full attachments plus the text fields. */
const MAX_FORM_BYTES = MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES + 256 * 1024;

/** Session user and parsed multipart form for the support routes. */
export async function readSupportForm(request: Request): Promise<{ user: User; form: FormData }> {
  if (!requestOriginMatches(request)) throw new ApiError('forbidden', 'Invalid request origin.', 403);
  const session = await createClient();
  const { data, error } = await session.auth.getUser();
  if (error || !data.user) throw new ApiError('unauthorized', 'Sign in to contact support.', 401);
  const bounded = await boundedRequest(request, MAX_FORM_BYTES).catch((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 413) {
      throw new ApiError('invalid_request', 'The attachments are too large. Each file can be up to 4 MB.', 413);
    }
    throw cause;
  });
  const form = await bounded.formData().catch(() => {
    throw new ApiError('invalid_request', 'The form could not be read. Reload the page and try again.', 400);
  });
  return { user: data.user, form };
}

export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export function formFiles(form: FormData, name: string): File[] {
  return form.getAll(name).filter((value): value is File => typeof value !== 'string');
}

/** Person-facing error JSON; the support UI shows `message` as is. */
export function supportError(error: unknown, requestId: string, log: Logger): Response {
  if (error instanceof ApiError) {
    return Response.json({ error: { message: error.message, request_id: requestId } }, { status: error.status });
  }
  log.error('support.request_failed', { error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' });
  return Response.json(
    { error: { message: `Something went wrong. Please try again, or email us and quote ${requestId}.`, request_id: requestId } },
    { status: 500 },
  );
}
