'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createClient } from '@/lib/supabase/client';
import { authRedirectPath } from '@/lib/auth/redirect';
import {
  CODE_LENGTH, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, RESEND_DELAY_SECONDS,
  signupDetailsSchema, sendSignupCode, verifySignupCode, signupErrorMessage, type SignupDetails,
} from '@/lib/auth/signup';
import { GoogleButton } from '../_components/google-button';
import { PasswordInput, authInputClass } from '../_components/password-input';
import { LoadingSpinner } from '../../_components/loading-skeleton';

export function SignupForm({ next }: { next?: string }) {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [sentDetails, setSentDetails] = useState<SignupDetails | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<'send' | 'verify' | 'google' | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const busy = pending !== null;

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  async function sendCode() {
    if (busy || inFlight.current || cooldown > 0) return;
    setError(null);
    const result = signupDetailsSchema.safeParse({ username, email, password, confirmPassword });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? 'Check your account details.');
      return;
    }
    inFlight.current = true;
    setPending('send');
    try {
      await sendSignupCode(createClient().auth, result.data, sentDetails !== null);
      setSentDetails(result.data);
      setCooldown(RESEND_DELAY_SECONDS);
      setCode('');
      codeInput.current?.focus();
    } catch (error) {
      setError(signupErrorMessage(error));
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || inFlight.current) return;
    if (!sentDetails) {
      await sendCode();
      return;
    }
    inFlight.current = true;
    setPending('verify');
    setError(null);
    try {
      await verifySignupCode(createClient().auth, sentDetails.email, code);
      router.replace(authRedirectPath(next));
      router.refresh();
    } catch (error) {
      setError(signupErrorMessage(error));
      codeInput.current?.focus();
      inFlight.current = false;
      setPending(null);
    }
  }

  function editDetails() {
    setSentDetails(null);
    setCode('');
    setCooldown(0);
    setError(null);
  }

  return (
    <div className="mt-7">
      <GoogleButton next={next} pending={pending === 'google'} disabled={busy}
        onPending={(value) => setPending(value ? 'google' : null)} onError={setError} />
      <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-busy={busy}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="username" className="text-sm font-medium text-zinc-900">Username</label>
          <input id="username" name="username" autoComplete="username" required minLength={3} maxLength={32}
            placeholder="Enter your username" value={username} onChange={(event) => setUsername(event.target.value)}
            readOnly={sentDetails !== null} disabled={busy} className={authInputClass} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-sm font-medium text-zinc-900">Password</label>
          <PasswordInput id="password" name="password" autoComplete="new-password" required
            minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} placeholder="Enter password (8–20 characters)"
            value={password} onChange={(event) => setPassword(event.target.value)} readOnly={sentDetails !== null} disabled={busy} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="confirm-password" className="text-sm font-medium text-zinc-900">Confirm password</label>
          <PasswordInput id="confirm-password" name="confirmPassword" autoComplete="new-password" required
            minLength={MIN_PASSWORD_LENGTH} maxLength={MAX_PASSWORD_LENGTH} placeholder="Confirm password"
            value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} readOnly={sentDetails !== null} disabled={busy} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium text-zinc-900">Email <span className="font-normal text-zinc-500">(required for verification)</span></label>
          <input id="email" name="email" type="email" autoComplete="email" required placeholder="name@example.com"
            value={email} onChange={(event) => setEmail(event.target.value)} readOnly={sentDetails !== null}
            disabled={busy} className={authInputClass} />
        </div>
        <div>
          <label htmlFor="verification-code" className="sr-only">Verification code</label>
          <div className="flex items-center gap-2">
            <input ref={codeInput} id="verification-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code"
              required={sentDetails !== null} minLength={CODE_LENGTH} maxLength={CODE_LENGTH} pattern="[0-9]{6}"
              placeholder="Verification code" value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))}
              readOnly={pending === 'verify' || pending === 'google'} aria-describedby={sentDetails ? 'code-sent' : undefined}
              className={authInputClass} />
            <button type="button" onClick={sendCode} disabled={busy || cooldown > 0 || !email.trim()}
              className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 disabled:cursor-not-allowed disabled:text-zinc-400">
              {pending === 'send' && <LoadingSpinner className="h-3.5 w-3.5" />}
              {pending === 'send' ? 'Sending…' : cooldown > 0 ? `Resend in ${cooldown}s` : sentDetails ? 'Resend code' : 'Send code'}
            </button>
          </div>
          {sentDetails && (
            <div id="code-sent" role="status" className="mt-2 text-xs leading-relaxed text-zinc-500">
              <p>We sent a 6-digit code to <span className="break-all font-medium text-zinc-700">{sentDetails.email}</span>. Check your inbox or spam folder.</p>
              <button type="button" disabled={busy} onClick={editDetails} className="mt-1 font-medium text-zinc-700 underline underline-offset-2">Edit account details</button>
            </div>
          )}
        </div>
        {error !== null && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button type="submit" disabled={busy || (!sentDetails && cooldown > 0)}
          className="mt-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-zinc-900 px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 disabled:cursor-wait disabled:opacity-60">
          {pending !== null && <LoadingSpinner />}
          {pending === 'verify' ? 'Verifying…' : pending === 'send' ? 'Sending code…' : 'Create account'}
        </button>
      </form>
    </div>
  );
}
