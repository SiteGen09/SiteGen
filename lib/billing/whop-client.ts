import { WhopClient } from '@whop/sdk';

/** Construct lazily so builds do not need production credentials. Server use only. */
export function createWhopClient(): WhopClient {
  const token = process.env.WHOP_API_KEY;
  if (!token) throw new Error('WHOP_API_KEY is not configured');
  return new WhopClient({
    token,
    apiVersionDate: '2026-09-15',
    timeoutInSeconds: 10,
    maxRetries: 0,
  });
}
