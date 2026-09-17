import Link from 'next/link';
import { LoginForm } from './login-form';

const ERROR_MESSAGES: Record<string, string> = {
  auth_callback_failed: 'That confirmation link is invalid or has expired. Sign in again.',
  missing_code: 'That confirmation link was incomplete. Sign in again.',
};

export const metadata = { title: 'Sign in — sitegen' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const errorParam = typeof params.error === 'string' ? params.error : undefined;
  const next = typeof params.next === 'string' ? params.next : undefined;

  return (
    <>
      <h1 className="text-lg font-semibold text-zinc-900">Sign in</h1>
      <p className="mt-1 text-sm text-zinc-500">Access your API keys, usage and credits.</p>
      <LoginForm
        next={next}
        initialError={errorParam === undefined ? null : (ERROR_MESSAGES[errorParam] ?? null)}
      />
      <p className="mt-6 text-sm text-zinc-500">
        No account?{' '}
        <Link href="/signup" className="font-medium text-zinc-900 underline">
          Create one
        </Link>
      </p>
    </>
  );
}
