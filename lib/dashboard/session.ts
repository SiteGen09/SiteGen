import { redirect } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';

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
