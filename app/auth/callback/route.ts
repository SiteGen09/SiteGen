import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { authRedirectPath, publicOrigin } from '@/lib/auth/redirect';
import { REFERRAL_COOKIE } from '@/lib/referrals/code';
import { claimReferral } from '@/lib/referrals/referrals';

/**
 * Completes the Google OAuth / PKCE flow and preserves the intended destination.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const origin = publicOrigin(request.headers, request.nextUrl.origin);
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

  let userId: string | undefined;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return failed('auth_callback_failed');
    userId = data?.user?.id;
  } catch {
    return failed('auth_callback_failed');
  }

  const response = NextResponse.redirect(new URL(target, origin));
  // A Google signup that started from a referral link. Existing accounts
  // signing in are refused by the database, so the cookie is spent either way.
  const referral = request.cookies.get(REFERRAL_COOKIE)?.value;
  if (referral !== undefined) {
    if (userId !== undefined) await claimReferral(userId, referral);
    response.cookies.delete(REFERRAL_COOKIE);
  }
  return response;
}
