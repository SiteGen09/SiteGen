import { expect, it } from 'vitest';
import { authCallbackUrl, authRedirectPath } from './redirect';

it.each([undefined, null, '', 'https://example.net', '//example.net', '/\\example.net', '/%2fexample.net', '/%5cexample.net', '/%0a/example.net', '/%'])('rejects unsafe redirect %j', (next) => {
  expect(authRedirectPath(next)).toBe('/dashboard');
});

it('preserves a local destination and its query through the OAuth callback URL', () => {
  const next = '/dashboard/billing?from=signup';
  const callback = new URL(authCallbackUrl('https://sitegen.example', next));
  expect(callback.origin).toBe('https://sitegen.example');
  expect(callback.pathname).toBe('/auth/callback');
  expect(callback.searchParams.get('next')).toBe(next);
});
