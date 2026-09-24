'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { newPasswordSchema, passwordResetErrorMessage } from '@/lib/auth/password-reset';
import { PasswordInput } from '../_components/password-input';
import { LoadingSpinner } from '../../_components/loading-skeleton';

export function ResetPasswordForm() {
  const router = useRouter();
  const [ready, setReady] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => { if (mounted) setReady(data.session !== null); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) setReady(session !== null);
    });
    return () => { mounted = false; listener.subscription.unsubscribe(); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const parsed = newPasswordSchema.safeParse({ password, confirmPassword });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Choose a valid password.');
      return;
    }
    setError(null);
    setPending(true);
    try {
      const { error: updateError } = await createClient().auth.updateUser({ password: parsed.data.password });
      if (updateError) throw updateError;
      await createClient().auth.signOut({ scope: 'local' });
      router.replace('/login?reset=success');
    } catch (failure) {
      setError(passwordResetErrorMessage(failure));
      setPending(false);
    }
  }

  if (ready === null) return <p className="mt-7 text-sm text-zinc-500">Checking your reset link…</p>;
  if (!ready) return <p role="alert" className="mt-7 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">This reset link or code is no longer active. Request a new one to continue.</p>;

  return (
    <form onSubmit={submit} className="mt-7 flex flex-col gap-4" aria-busy={pending}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="new-password" className="text-sm font-medium text-zinc-900">New password</label>
        <PasswordInput id="new-password" name="password" autoComplete="new-password" required minLength={8} maxLength={20}
          placeholder="Enter password (8–20 characters)" value={password} onChange={(event) => setPassword(event.target.value)} disabled={pending} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="confirm-new-password" className="text-sm font-medium text-zinc-900">Confirm new password</label>
        <PasswordInput id="confirm-new-password" name="confirmPassword" autoComplete="new-password" required minLength={8} maxLength={20}
          placeholder="Confirm password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={pending} />
      </div>
      {error !== null && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={pending}
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3 py-2.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-60">
        {pending && <LoadingSpinner />}
        {pending ? 'Updating password…' : 'Update password'}
      </button>
    </form>
  );
}
