/** Keep auth redirects on this site, including when `next` came from a URL. */
export function authRedirectPath(next?: string | null): string {
  if (!next?.startsWith('/') || next.startsWith('//')) return '/dashboard';
  try {
    const decoded = decodeURIComponent(next);
    if (decoded.startsWith('//') || /[\\\u0000-\u0020]/.test(decoded)) return '/dashboard';
  } catch {
    return '/dashboard';
  }
  return next;
}

/**
 * The origin the browser used. Behind the Cloudflare Tunnel, `next start`
 * builds request URLs from its listen address (localhost:3000); Next copies the
 * browser's Host into x-forwarded-host and cloudflared sets x-forwarded-proto.
 */
export function publicOrigin(headers: Headers, fallbackOrigin: string): string {
  const host = headers.get('x-forwarded-host')?.split(',')[0]?.trim() || headers.get('host');
  const proto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (!host || /[/\\@?#\s]/.test(host) || (proto !== 'http' && proto !== 'https')) return fallbackOrigin;
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return fallbackOrigin;
  }
}

export function authCallbackUrl(origin: string, next?: string | null): string {
  const url = new URL('/auth/callback', origin);
  url.searchParams.set('next', authRedirectPath(next));
  return url.toString();
}
