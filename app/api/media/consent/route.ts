import { randomUUID } from 'node:crypto';
import { dashboardErrorFrom } from '@/lib/api/dashboard-errors';
import { ApiError } from '@/lib/api/errors';
import { requestOriginMatches } from '@/lib/api/request-origin';
import { logger } from '@/lib/log';
import { acceptMediaPolicy, loadMediaAccess } from '@/lib/safety/media-gate';
import { createClient } from '@/lib/supabase/server';

/**
 * Records that the signed-in user agreed to the Acceptable Use Policy, which
 * image and video generation requires (for the API as well as the dashboard).
 * The time of the first agreement is kept; agreeing again changes nothing.
 */

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  const log = logger({ request_id: requestId, route: 'dashboard.media.consent' });
  try {
    const session = await createClient();
    const { data, error } = await session.auth.getUser();
    if (error !== null || data.user === null) throw new ApiError('unauthorized', 'sign in to continue', 401);
    if (!requestOriginMatches(request)) throw new ApiError('forbidden', 'Invalid request origin.', 403);
    const body = (await request.json().catch(() => null)) as { accepted?: unknown } | null;
    if (body?.accepted !== true) throw new ApiError('invalid_request', 'Tick the box to agree to the Acceptable Use Policy.', 400);
    await acceptMediaPolicy(data.user.id);
    log.info('media_policy.accepted', { user_id: data.user.id });
    const access = await loadMediaAccess(data.user.id);
    return Response.json({ accepted: access.accepted, suspended: access.suspended });
  } catch (err) {
    return dashboardErrorFrom(err, requestId);
  }
}
