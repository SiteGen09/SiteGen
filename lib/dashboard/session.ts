import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';

/**
 * The signed-in user, or a redirect to /login. Middleware already gates
 * /dashboard, but every server component and server action re-checks: a page
 * must never render, and an action must never write, on an assumed session.
 */
export async function requireUser(): Promise<User> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user === null) redirect('/login');
  return user;
}

/**
 * Whether to offer the admin portal link. Read with the service client, as
 * requireAdmin does, so an RLS gap cannot hide the link from an admin. This
 * only decides visibility: the /admin layout re-checks with requireAdmin.
 */
export async function isAdmin(userId: string): Promise<boolean> {
  const { data, error } = await createServiceClient()
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  return error === null && (data as { role?: unknown } | null)?.role === 'admin';
}
