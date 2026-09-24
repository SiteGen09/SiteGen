import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendSignupCode, signupDetailsSchema, signupErrorMessage, verifySignupCode } from './signup';

const auth = {
  signUp: vi.fn(), resend: vi.fn(), verifyOtp: vi.fn(), signOut: vi.fn(),
};
const client = auth as unknown as SupabaseClient['auth'];
const details = { username: 'new_user', email: ' NEW@EXAMPLE.COM ', password: 'safe-password', confirmPassword: 'safe-password' };

beforeEach(() => {
  vi.resetAllMocks();
  auth.signUp.mockResolvedValue({ data: { user: { id: 'pending' }, session: null }, error: null });
  auth.resend.mockResolvedValue({ error: null });
  auth.signOut.mockResolvedValue({ error: null });
});

describe('email signup', () => {
  it.each([
    { email: '' }, { email: 'not-an-email' }, { username: '  ' }, { password: 'short' },
    { password: 'x'.repeat(21), confirmPassword: 'x'.repeat(21) }, { confirmPassword: 'different-password' },
  ])('rejects invalid details before contacting auth: %j', async (invalid) => {
    expect(signupDetailsSchema.safeParse({ ...details, ...invalid }).success).toBe(false);
    await expect(sendSignupCode(client, { ...details, ...invalid })).rejects.toThrow();
    expect(auth.signUp).not.toHaveBeenCalled();
    expect(auth.resend).not.toHaveBeenCalled();
  });

  it('registers a pending account with a normalized email and saved username', async () => {
    await sendSignupCode(client, details);
    expect(auth.signUp).toHaveBeenCalledWith({
      email: 'new@example.com', password: 'safe-password', options: { data: { username: 'new_user' } },
    });
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('resends the pending confirmation without creating another account', async () => {
    await sendSignupCode(client, details, true);
    expect(auth.resend).toHaveBeenCalledWith({ type: 'signup', email: 'new@example.com' });
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('rejects an auto-confirmed signup and discards its session', async () => {
    auth.signUp.mockResolvedValue({ data: { session: { access_token: 'unexpected' } }, error: null });
    await expect(sendSignupCode(client, details)).rejects.toThrow('Email verification is temporarily unavailable');
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });

  it('keeps delivery and rate-limit failures visible', async () => {
    const failure = Object.assign(new Error('Rate limit'), { code: 'over_email_send_rate_limit' });
    auth.resend.mockResolvedValue({ error: failure });
    await expect(sendSignupCode(client, details, true)).rejects.toBe(failure);
    expect(signupErrorMessage(failure)).toContain('wait a minute');
  });
});

describe('code verification', () => {
  it.each(['', '12345', '1234567', 'abcdef'])('rejects malformed code %j before verification', async (code) => {
    await expect(verifySignupCode(client, details.email, code)).rejects.toThrow('6-digit');
    expect(auth.verifyOtp).not.toHaveBeenCalled();
  });

  it('verifies the email code and requires a confirmed user and session', async () => {
    auth.verifyOtp.mockResolvedValue({ data: { session: { access_token: 'verified' }, user: { email_confirmed_at: '2026-09-21' } }, error: null });
    await expect(verifySignupCode(client, details.email, '123456')).resolves.toBeUndefined();
    expect(auth.verifyOtp).toHaveBeenCalledWith({ email: 'new@example.com', token: '123456', type: 'email' });
  });

  it('does not accept an expired or incorrect code', async () => {
    const failure = Object.assign(new Error('Token expired'), { code: 'otp_expired' });
    auth.verifyOtp.mockResolvedValue({ data: { session: null }, error: failure });
    await expect(verifySignupCode(client, details.email, '123456')).rejects.toBe(failure);
    expect(signupErrorMessage(failure)).toContain('invalid or has expired');
  });

  it.each([
    { session: null, user: { email_confirmed_at: '2026-09-21' } },
    { session: { access_token: 'unverified' }, user: { email_confirmed_at: null } },
  ])('rejects incomplete confirmation data: %j', async (data) => {
    auth.verifyOtp.mockResolvedValue({ data, error: null });
    await expect(verifySignupCode(client, details.email, '123456')).rejects.toThrow('could not be verified');
    if (data.session) expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
  });
});
