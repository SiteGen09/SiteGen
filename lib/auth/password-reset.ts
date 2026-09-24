import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

export const RESET_CODE_LENGTH = 6;
export const RESET_RESEND_DELAY_SECONDS = 60;
export const MIN_RESET_PASSWORD_LENGTH = 8;
export const MAX_RESET_PASSWORD_LENGTH = 20;

export const resetEmailSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.')),
});

export const newPasswordSchema = z.object({
  password: z.string().min(MIN_RESET_PASSWORD_LENGTH, 'Password must be at least 8 characters.')
    .max(MAX_RESET_PASSWORD_LENGTH, 'Password must be no more than 20 characters.'),
  confirmPassword: z.string(),
}).refine((value) => value.password === value.confirmPassword, {
  message: 'Passwords do not match.',
  path: ['confirmPassword'],
});

type PasswordResetAuth = Pick<SupabaseClient['auth'], 'resetPasswordForEmail' | 'verifyOtp'>;

export async function sendPasswordResetCode(
  auth: PasswordResetAuth,
  email: string,
  redirectTo: string,
): Promise<void> {
  const parsed = resetEmailSchema.parse({ email });
  const { error } = await auth.resetPasswordForEmail(parsed.email, { redirectTo });
  if (error) throw error;
}

export async function verifyPasswordResetCode(
  auth: PasswordResetAuth,
  email: string,
  code: string,
): Promise<void> {
  const parsed = resetEmailSchema.parse({ email });
  const token = code.trim();
  if (!/^\d{6}$/.test(token)) throw new Error('Enter the 6-digit code from your email.');
  const { data, error } = await auth.verifyOtp({ email: parsed.email, token, type: 'recovery' });
  if (error) throw error;
  if (!data.session) throw new Error('Your reset code could not start a recovery session. Request a new code.');
}

export function passwordResetErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'otp_expired') return 'That code is invalid or has expired. Request a new code.';
    if (error.code === 'over_email_send_rate_limit' || error.code === 'over_request_rate_limit') {
      return 'Please wait a minute before requesting another code.';
    }
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
