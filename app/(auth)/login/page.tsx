import Link from 'next/link';
import { LoginForm } from './login-form';
import { authRedirectPath } from '@/lib/auth/redirect';

const ERROR_MESSAGES: Record<string, string> = {
  auth_callback_failed: 'We could not finish signing you in. Please try again.',
  missing_code: 'The sign-in link was incomplete. Please try again.',
  access_denied: 'Google sign-in was cancelled. Try again or sign in with email.',
};

export const metadata = { title: 'Sign in — sitegen' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const errorParam = typeof params.error === 'string' ? params.error : undefined;
  const next = authRedirectPath(typeof params.next === 'string' ? params.next : undefined);
  const resetComplete = params.reset === 'success';

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Sign in</h1>
      <p className="mt-2 text-sm text-zinc-500">
        No account?{' '}
        <Link href={`/signup?next=${encodeURIComponent(next)}`} className="font-medium text-zinc-900 underline underline-offset-2">
          Create one
        </Link>.
      </p>
      {resetComplete && <p role="status" className="mt-5 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Your password was updated. Sign in with your new password.</p>}
      <LoginForm
        next={next}
        initialError={errorParam === undefined ? null : (ERROR_MESSAGES[errorParam] ?? null)}
      />
    </>
  );
}
