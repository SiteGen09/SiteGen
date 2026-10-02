import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { publicOrigin } from '@/lib/auth/redirect';
import { REFERRAL_COOKIE, normalizeReferralCode, referralCookieOptions } from '@/lib/referrals/code';

/** Signed-in-only surfaces. Anything else is public. */
const PROTECTED_PREFIXES = ['/dashboard'] as const;
/** Pages that make no sense with a live session. */
const AUTH_PATHS = ['/login', '/signup'] as const;

/**
 * Refreshes the Supabase session cookies on every page navigation and gates the
 * dashboard. Cookies written by the auth client have to land on BOTH the
 * forwarded request (so server components in this same pass see the fresh
 * token) and the outgoing response (so the browser keeps it).
 */
export async function middleware(request: NextRequest) {
  const response = await route(request);
  // A shared referral link can land on any page; remember the code until
  // signup claims it. The newest link wins.
  const referral = normalizeReferralCode(request.nextUrl.searchParams.get('ref'));
  if (referral !== null) response.cookies.set(REFERRAL_COOKIE, referral, referralCookieOptions);
  return response;
}

async function route(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser() (not getSession()) so the token is verified and refreshed here.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  const origin = publicOrigin(request.headers, request.nextUrl.origin);

  if (!user && isProtected) {
    const url = new URL('/login', origin);
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (user && (AUTH_PATHS as readonly string[]).includes(pathname)) {
    return NextResponse.redirect(new URL('/dashboard', origin));
  }

  return response;
}

export const config = {
  // Page traffic only: the /v1 API authenticates by API key, /api routes
  // (webhooks, cron) must not pay for a cookie round-trip, and the install
  // scripts are fetched by curl and PowerShell, which carry no session.
  matcher: [
    '/((?!api/|v1/|_next/static|_next/image|favicon.ico|(?:un)?install\\.(?:sh|ps1)$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
