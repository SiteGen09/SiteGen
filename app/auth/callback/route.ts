import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { authRedirectPath } from '@/lib/auth/redirect';

/**
 * Completes the Google OAuth / PKCE flow and preserves the intended destination.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const target = authRedirectPath(searchParams.get('next'));
  function failed(reason: string) {
    const url = new URL('/login', origin);
    url.searchParams.set('error', reason);
    url.searchParams.set('next', target);
    return NextResponse.redirect(url);
  }

  if (searchParams.has('error')) {
    return failed(searchParams.get('error') === 'access_denied' ? 'access_denied' : 'auth_callback_failed');
  }

  if (!code) {
    return failed('missing_code');
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return failed('auth_callback_failed');
  } catch {
    return failed('auth_callback_failed');
  }

  return NextResponse.redirect(new URL(target, origin));
}
