import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 20;
export const CODE_LENGTH = 6;
export const RESEND_DELAY_SECONDS = 60;

export const signupDetailsSchema = z.object({
  username: z.string().trim().min(3, 'Use at least 3 characters for your username.')
    .max(32, 'Use no more than 32 characters for your username.')
    .regex(/^[a-zA-Z0-9_.-]+$/, 'Use letters, numbers, dots, underscores or hyphens for your username.'),
  password: z.string().min(MIN_PASSWORD_LENGTH, 'Password must be at least 8 characters.')
    .max(MAX_PASSWORD_LENGTH, 'Password must be no more than 20 characters.'),
  confirmPassword: z.string(),
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.')),
}).refine((details) => details.password === details.confirmPassword, {
  message: 'Passwords do not match.',
  path: ['confirmPassword'],
});

export type SignupDetails = z.infer<typeof signupDetailsSchema>;
type SignupAuth = Pick<SupabaseClient['auth'], 'signUp' | 'resend' | 'verifyOtp' | 'signOut'>;

export async function sendSignupCode(auth: SignupAuth, details: SignupDetails, resend = false) {
  const { email, password, username } = signupDetailsSchema.parse(details);
  if (resend) {
    const { error } = await auth.resend({ type: 'signup', email });
    if (error) throw error;
    return;
  }
  const { data, error } = await auth.signUp({ email, password, options: { data: { username } } });
  if (error) throw error;
  // Confirmations must also be enabled in Supabase. An automatic session is
  // not proof that the visitor entered the emailed code.
  if (data.session) {
    await auth.signOut({ scope: 'local' });
    throw new Error('Email verification is temporarily unavailable. Please try again later.');
  }
}

export async function verifySignupCode(auth: SignupAuth, email: string, code: string) {
  const token = code.trim();
  if (!/^\d{6}$/.test(token)) throw new Error('Enter the 6-digit code from your email.');
  const { data, error } = await auth.verifyOtp({ email: email.trim().toLowerCase(), token, type: 'email' });
  if (error) throw error;
  if (!data.session || !data.user?.email_confirmed_at) {
    if (data.session) await auth.signOut({ scope: 'local' });
    throw new Error('Your email could not be verified. Request a new code and try again.');
  }
}

export function signupErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'otp_expired') return 'That code is invalid or has expired. Check it or request a new code.';
    if (error.code === 'over_email_send_rate_limit' || error.code === 'over_request_rate_limit') {
      return 'Please wait a minute before requesting another code.';
    }
    if (error.code === 'user_already_exists' || error.code === 'email_exists') {
      return 'An account already uses this email. Sign in instead.';
    }
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
