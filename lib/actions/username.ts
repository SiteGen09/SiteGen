'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { trustedClientIp } from '@/lib/keys/key-policy';
import { logger } from '@/lib/log';
import { createServiceClient } from '@/lib/supabase/service';

const log = logger({ component: 'username-login' });

/** Same wording Supabase Auth uses, so a username and an email fail alike. */
const INVALID_LOGIN = 'Invalid login credentials';

/**
 * The email behind a username, released only when the password matches.
 * The browser then signs in with that email through Supabase Auth as usual.
 */
export async function usernameLoginEmail(username: string, password: string): Promise<{ email: string } | { error: string }> {
  try {
    const ip = trustedClientIp(await headers());
    const { data, error } = await createServiceClient().rpc('username_login_email', {
      p_username: username.trim(), p_password: password, p_ip: ip ?? 'unknown',
    });
    if (error) throw new Error(error.message);
    const result = z.object({ status: z.enum(['ok', 'invalid', 'rate_limited']), email: z.string().optional() }).parse(data);
    if (result.status === 'rate_limited') return { error: 'Too many sign-in attempts. Wait a minute and try again.' };
    if (result.status !== 'ok' || !result.email) return { error: INVALID_LOGIN };
    return { email: result.email };
  } catch (error) {
    log.error('username_login.failed', { error: error instanceof Error ? error.message : String(error) });
    return { error: 'Could not sign in. Please try again.' };
  }
}

/** Signup check. Usernames are public handles, so saying one is taken is fine. */
export async function usernameAvailable(username: string): Promise<boolean> {
  const { data, error } = await createServiceClient().rpc('username_available', { p_username: username.trim() });
  if (error) {
    log.error('username_available.failed', { error: error.message });
    // Let signup continue; the database still refuses a duplicate.
    return true;
  }
  return data === true;
}
