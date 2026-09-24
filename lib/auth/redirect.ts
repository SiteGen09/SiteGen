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

export function authCallbackUrl(origin: string, next?: string | null): string {
  const url = new URL('/auth/callback', origin);
  url.searchParams.set('next', authRedirectPath(next));
  return url.toString();
}
