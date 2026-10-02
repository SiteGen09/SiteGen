import { randomUUID } from 'node:crypto';

import { apiError } from '@/lib/api/errors';
import { requireAdmin } from '@/lib/api/admin';
import { loadAttachment } from '@/lib/support/tickets';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/**
 * One support attachment, for the ticket's owner or an admin. The stored type
 * was decided from the file's bytes at upload, and the response is sandboxed
 * and never sniffed, so an upload cannot run script on this origin.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const session = await createClient();
  const { data, error } = await session.auth.getUser();
  if (error || !data.user) return apiError('unauthorized', 'sign in to view attachments', requestId, 401);

  const { id } = await context.params;
  const file = await loadAttachment(id);
  let allowed = file !== null && file.ownerId === data.user.id;
  if (file !== null && !allowed) {
    allowed = await requireAdmin().then(() => true, () => false);
  }
  // Someone else's attachment looks exactly like a missing one.
  if (file === null || !allowed) return apiError('not_found', 'no such attachment', requestId, 404);

  const inline = file.mediaType.startsWith('image/') || file.mediaType === 'text/plain' || file.mediaType === 'application/json';
  const filename = encodeURIComponent(file.filename);
  return new Response(new Uint8Array(file.data), {
    headers: {
      'content-type': file.mediaType.startsWith('text/') ? `${file.mediaType}; charset=utf-8` : file.mediaType,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`,
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}
