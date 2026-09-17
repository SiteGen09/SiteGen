import type { TransactionSql } from 'postgres';
import { z } from 'zod';

import { ApiError } from '@/lib/api/errors';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * Admin authorization and audit trail.
 *
 * Server-only: every export reads the session cookie or the service-role client.
 * Never import from a client component.
 */

const profileSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.string(),
});

export type AdminProfile = z.infer<typeof profileSchema>;

export interface AdminContext {
  user: { id: string; email: string | null };
  profile: AdminProfile;
}

/**
 * Resolves the caller and asserts the admin role.
 *
 * The session is read with the anon/RLS client (the cookie is the only thing we
 * trust from the browser); the role is then read with the service client so a
 * missing RLS grant cannot silently downgrade an admin to a 403.
 *
 * Throws `ApiError('unauthorized', …, 401)` with no session and
 * `ApiError('forbidden', …, 403)` for any non-admin.
 */
export async function requireAdmin(): Promise<AdminContext> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  if (error !== null || data.user === null) {
    throw new ApiError('unauthorized', 'authentication required', 401);
  }
  const user = data.user;

  const service = createServiceClient();
  const profileResult = await service
    .from('profiles')
    .select('id, email, role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileResult.error !== null) {
    throw new ApiError('internal_error', 'failed to load profile', 500);
  }

  const parsed = profileSchema.safeParse(profileResult.data as unknown);
  if (!parsed.success) {
    throw new ApiError('forbidden', 'admin access required', 403);
  }
  if (parsed.data.role !== 'admin') {
    throw new ApiError('forbidden', 'admin access required', 403);
  }

  return {
    user: { id: user.id, email: user.email ?? null },
    profile: parsed.data,
  };
}

/** Serialized JSON for a jsonb column: SQL NULL for nullish, else a JSON string. */
function jsonbParam(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * Appends one row to `admin_audit_log`.
 *
 * Every admin mutation must call this in the same logical operation and must
 * fail if it throws: an unaudited privileged write is worse than a retry, so
 * callers propagate rather than swallow.
 *
 * Pass `tx` (a Postgres transaction) to write the audit row inside the same
 * transaction as the mutation it records — then the mutation and its audit
 * commit or roll back together. Without `tx` the row is written through the
 * service-role client as a standalone insert.
 */
export async function writeAudit(
  actorId: string,
  action: string,
  target: string,
  before: unknown,
  after: unknown,
  tx?: TransactionSql,
): Promise<void> {
  if (tx !== undefined) {
    await tx`
      INSERT INTO admin_audit_log (actor_id, action, target, before, after)
      VALUES (
        ${actorId}, ${action}, ${target},
        ${jsonbParam(before)}::jsonb, ${jsonbParam(after)}::jsonb
      )
    `;
    return;
  }

  const service = createServiceClient();
  const { error } = await service.from('admin_audit_log').insert({
    actor_id: actorId,
    action,
    target,
    before: before === undefined ? null : before,
    after: after === undefined ? null : after,
  });

  if (error !== null) {
    throw new ApiError('internal_error', `audit write failed: ${error.message}`, 500);
  }
}
