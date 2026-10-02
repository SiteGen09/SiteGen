import Link from 'next/link';
import { cookies } from 'next/headers';
import { SignupForm } from './signup-form';
import { authRedirectPath } from '@/lib/auth/redirect';
import { REFERRAL_COOKIE, normalizeReferralCode } from '@/lib/referrals/code';

export const metadata = { title: 'Create account — sitegen' };

export default async function SignupPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = authRedirectPath(typeof params.next === 'string' ? params.next : undefined);
  // Middleware stores ?ref= in a cookie on this same request, so read both.
  const referralCode = normalizeReferralCode(params.ref) ?? normalizeReferralCode((await cookies()).get(REFERRAL_COOKIE)?.value);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Create an account</h1>
      <p className="mt-2 text-sm text-zinc-500">
        Already have an account?{' '}
        <Link href={`/login?next=${encodeURIComponent(next)}`} className="font-medium text-zinc-900 underline underline-offset-2">
          Sign in
        </Link>.
      </p>
      <SignupForm next={next} referralCode={referralCode ?? undefined} />
    </>
  );
}
