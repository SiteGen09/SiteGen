/**
 * Referral codes travel from a shared link (`?ref=CODE`) to signup in a
 * first-party cookie. Codes are public, so the cookie only needs to survive
 * the visit; the database decides whether a claim is valid.
 */
export const REFERRAL_COOKIE = 'sg_ref';
export const REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export const referralCookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  maxAge: REFERRAL_COOKIE_MAX_AGE,
} as const;

/** Upper-cased code, or null when the value cannot be a referral code. */
export function normalizeReferralCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{4,16}$/.test(code) ? code : null;
}

export function referralLink(origin: string, code: string): string {
  const url = new URL('/signup', origin);
  url.searchParams.set('ref', code);
  return url.toString();
}
