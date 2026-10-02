'use server';

import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { REFERRAL_COOKIE, normalizeReferralCode, referralCookieOptions } from '@/lib/referrals/code';
import { claimReferral } from '@/lib/referrals/referrals';

/**
 * Runs right after email verification. A code typed on the signup form wins
 * over one remembered from a link. Never throws, so signup always completes.
 */
export async function claimSignupReferral(typed?: string): Promise<void> {
  const jar = await cookies();
  const code = typed?.trim() || jar.get(REFERRAL_COOKIE)?.value;
  if (!code) return;
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (user === null) return;
  await claimReferral(user.id, code);
  jar.delete(REFERRAL_COOKIE);
}

/** Keeps a code typed on the signup form for a Google signup, which leaves the page. */
export async function rememberReferralCode(typed: string): Promise<void> {
  const jar = await cookies();
  const code = normalizeReferralCode(typed);
  if (code === null) jar.delete(REFERRAL_COOKIE);
  else jar.set(REFERRAL_COOKIE, code, referralCookieOptions);
}
