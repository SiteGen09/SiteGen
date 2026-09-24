'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { createClient } from '@/lib/supabase/client';
import { authRedirectPath } from '@/lib/auth/redirect';
import { GoogleButton } from '../_components/google-button';
import { PasswordInput, authInputClass } from '../_components/password-input';
import { LoadingSpinner } from '../../_components/loading-skeleton';

export function LoginForm({ next, initialError }: { next: string | undefined; initialError: string | null }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  const [pending, setPending] = useState<'password' | 'google' | null>(null);
  const busy = pending !== null;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setPending('password');
    setError(null);
    try {
      const { error: signInError } = await createClient().auth.signInWithPassword({ email: email.trim(), password });
      if (signInError) throw signInError;
      router.replace(authRedirectPath(next));
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not sign in. Please try again.');
      setPending(null);
    }
  }

  return (
    <div className="mt-7">
      <GoogleButton next={next} pending={pending === 'google'} disabled={busy}
        onPending={(value) => setPending(value ? 'google' : null)} onError={setError} />
      <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-busy={busy}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium text-zinc-900">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required placeholder="name@example.com"
            value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} className={authInputClass} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-sm font-medium text-zinc-900">Password</label>
          <PasswordInput id="password" name="password" autoComplete="current-password" required placeholder="Enter your password"
            value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
        </div>
        {error !== null && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button type="submit" disabled={busy}
          className="mt-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3 py-2.5 text-sm font-semibold text-white hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 disabled:cursor-wait disabled:opacity-60">
          {pending === 'password' && <LoadingSpinner />}
          {pending === 'password' ? 'Signing in…' : 'Sign in'}
        </button>
        <Link href="/forgot-password" className="text-center text-sm text-zinc-600 underline underline-offset-2">Forgot your password?</Link>
      </form>
    </div>
  );
}
