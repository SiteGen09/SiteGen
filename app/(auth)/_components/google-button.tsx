'use client';

import { createClient } from '@/lib/supabase/client';
import { authCallbackUrl } from '@/lib/auth/redirect';
import { LoadingSpinner } from '../../_components/loading-skeleton';

export function GoogleButton({ next, pending, disabled, onPending, onError }: {
  next?: string;
  pending: boolean;
  disabled: boolean;
  onPending: (pending: boolean) => void;
  onError: (message: string | null) => void;
}) {
  async function continueWithGoogle() {
    if (disabled) return;
    onPending(true);
    onError(null);
    try {
      // Supabase constructs an OAuth URL even when a provider is disabled.
      // Check its public settings so that case stays on the usable auth form.
      const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`, {
        headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
      });
      if (!response.ok) throw new Error('Could not connect to Google sign-in. Please try again.');
      const settings = await response.json();
      if (!settings.external?.google) throw new Error('Google sign-in is not available yet. Please use email to continue.');
      const { data, error } = await createClient().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: authCallbackUrl(window.location.origin, next), skipBrowserRedirect: true },
      });
      if (error) throw error;
      if (!data.url) throw new Error('Could not connect to Google sign-in. Please try again.');
      window.location.assign(data.url);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not connect to Google sign-in. Please try again.');
      onPending(false);
    }
  }
  return (
    <div className="mb-6">
      <div className="mb-4 flex items-center gap-3" aria-hidden="true">
        <span className="h-px flex-1 bg-zinc-200" />
        <span className="text-[11px] tracking-wide text-zinc-500">OR CONTINUE WITH</span>
        <span className="h-px flex-1 bg-zinc-200" />
      </div>
      <button type="button" onClick={continueWithGoogle} disabled={disabled}
        className="flex min-h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-zinc-400 bg-white px-3 py-2.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 disabled:cursor-wait disabled:opacity-60">
        {pending && <LoadingSpinner className="h-4 w-4" />}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36ZM12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.04.96-3.38.96-2.6 0-4.8-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22ZM6.4 13.92A6 6 0 0 1 6.09 12c0-.67.11-1.32.31-1.92V7.49H3.06A10 10 0 0 0 2 12c0 1.61.38 3.14 1.06 4.51l3.34-2.59ZM12 5.96c1.47 0 2.79.51 3.83 1.51l2.88-2.88A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.94 5.49l3.34 2.59C7.2 7.72 9.4 5.96 12 5.96Z" />
        </svg>
        {pending ? 'Connecting to Google…' : 'Continue with Google'}
      </button>
    </div>
  );
}
