'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { authCallbackUrl } from '@/lib/auth/redirect';
import {
  RESET_CODE_LENGTH, RESET_RESEND_DELAY_SECONDS, resetEmailSchema,
  sendPasswordResetCode, verifyPasswordResetCode, passwordResetErrorMessage,
} from '@/lib/auth/password-reset';
import { authInputClass } from '../_components/password-input';
import { LoadingSpinner } from '../../_components/loading-skeleton';

export function ForgotPasswordForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [pending, setPending] = useState<'send' | 'verify' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const busy = pending !== null;

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function sendCode() {
    if (busy || cooldown > 0) return;
    const parsed = resetEmailSchema.safeParse({ email });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter the email on your account.');
      return;
    }
    setError(null);
    setPending('send');
    try {
      await sendPasswordResetCode(createClient().auth, parsed.data.email, authCallbackUrl(window.location.origin, '/reset-password'));
      setSent(true);
      setCooldown(RESET_RESEND_DELAY_SECONDS);
      setCode('');
      window.setTimeout(() => codeInput.current?.focus(), 0);
    } catch (failure) {
      setError(passwordResetErrorMessage(failure));
    } finally {
      setPending(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!sent) {
      await sendCode();
      return;
    }
    setError(null);
    setPending('verify');
    try {
      await verifyPasswordResetCode(createClient().auth, email, code);
      router.replace('/reset-password');
    } catch (failure) {
      setError(passwordResetErrorMessage(failure));
      setPending(null);
    }
  }

  return (
    <form onSubmit={submit} className="mt-7 flex flex-col gap-4" aria-busy={busy}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="reset-email" className="text-sm font-medium text-zinc-900">Email</label>
        <input id="reset-email" name="email" type="email" autoComplete="email" required placeholder="name@example.com"
          value={email} onChange={(event) => setEmail(event.target.value)} readOnly={sent} disabled={busy} className={authInputClass} />
      </div>
      {sent && <div className="flex flex-col gap-1.5">
        <label htmlFor="reset-code" className="text-sm font-medium text-zinc-900">Verification code</label>
        <input ref={codeInput} id="reset-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
          required minLength={RESET_CODE_LENGTH} maxLength={RESET_CODE_LENGTH} pattern="[0-9]{6}" placeholder="6-digit code"
          value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, RESET_CODE_LENGTH))}
          disabled={busy} className={authInputClass} />
        <p className="text-xs leading-5 text-zinc-500">Check your inbox or spam folder. The code expires after 10 minutes.</p>
      </div>}
      {error !== null && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={busy || (sent && code.length !== RESET_CODE_LENGTH)}
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3 py-2.5 text-sm font-semibold text-white hover:bg-zinc-700 disabled:cursor-wait disabled:opacity-60">
        {pending !== null && <LoadingSpinner />}
        {pending === 'send' ? 'Sending code…' : pending === 'verify' ? 'Checking code…' : sent ? 'Continue' : 'Send reset code'}
      </button>
      {sent && <button type="button" onClick={sendCode} disabled={busy || cooldown > 0}
        className="inline-flex items-center justify-center gap-2 text-sm text-zinc-600 underline underline-offset-2 disabled:no-underline disabled:opacity-50">
        {pending === 'send' && <LoadingSpinner className="h-3.5 w-3.5" />}
        {cooldown > 0 ? 'Resend code in ' + cooldown + 's' : 'Resend code'}
      </button>}
    </form>
  );
}
