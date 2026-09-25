/**
 * Match browser Origin against the request URL or the app's configured public
 * URL. Behind an HTTPS reverse proxy, request.url can describe the internal
 * HTTP hop while NEXT_PUBLIC_APP_URL remains the browser-facing origin.
 */
function parseOrigin(value: string, header = false): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (header && (url.pathname !== '/' || url.search || url.hash)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Requests without Origin are kept compatible with non-browser API callers. */
export function requestOriginMatches(
  request: Request,
  configuredAppUrl = process.env.NEXT_PUBLIC_APP_URL,
): boolean {
  const header = request.headers.get('origin');
  if (header === null) return true;
  const browserOrigin = parseOrigin(header, true);
  if (browserOrigin === null) return false;

  if (browserOrigin === parseOrigin(request.url)) return true;
  const configuredOrigin = configuredAppUrl ? parseOrigin(configuredAppUrl) : null;
  return configuredOrigin !== null && browserOrigin === configuredOrigin;
}
