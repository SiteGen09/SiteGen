import { expect, it } from 'vitest';
import { authCallbackUrl, authRedirectPath, publicOrigin } from './redirect';

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

it('uses the forwarded public origin and falls back when headers are missing or malformed', () => {
  const fallback = 'http://localhost:3000';
  const h = (init: Record<string, string>) => new Headers(init);
  expect(publicOrigin(h({ 'x-forwarded-host': 'gensite.tech', 'x-forwarded-proto': 'https' }), fallback)).toBe('https://gensite.tech');
  expect(publicOrigin(h({ host: 'gensite.tech', 'x-forwarded-proto': 'https,http' }), fallback)).toBe('https://gensite.tech');
  expect(publicOrigin(h({ 'x-forwarded-host': 'localhost:3000', 'x-forwarded-proto': 'http' }), fallback)).toBe('http://localhost:3000');
  expect(publicOrigin(h({}), fallback)).toBe(fallback);
  expect(publicOrigin(h({ 'x-forwarded-host': 'evil.example/path', 'x-forwarded-proto': 'https' }), fallback)).toBe(fallback);
  expect(publicOrigin(h({ 'x-forwarded-host': 'gensite.tech', 'x-forwarded-proto': 'javascript' }), fallback)).toBe(fallback);
});
