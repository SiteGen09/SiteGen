import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

const { exchange } = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { exchangeCodeForSession: exchange } }) }));
beforeEach(() => { exchange.mockReset(); exchange.mockResolvedValue({ error: null }); });

it('exchanges an OAuth code and redirects to the requested local page', async () => {
  const result = await GET(new NextRequest('http://localhost/auth/callback?code=valid&next=%2Fdashboard%2Fbilling'));
  expect(exchange).toHaveBeenCalledWith('valid');
  expect(result.headers.get('location')).toBe('http://localhost/dashboard/billing');
});

it('ignores external destinations after a successful exchange', async () => {
  const result = await GET(new NextRequest('http://localhost/auth/callback?code=valid&next=%2F%2Fevil.example'));
  expect(result.headers.get('location')).toBe('http://localhost/dashboard');
});

it('handles Google cancellation without attempting an exchange', async () => {
  const result = await GET(new NextRequest('http://localhost/auth/callback?error=access_denied&next=%2Fdashboard%2Fbilling'));
  const location = new URL(result.headers.get('location')!);
  expect(location.pathname).toBe('/login');
  expect(location.searchParams.get('error')).toBe('access_denied');
  expect(location.searchParams.get('next')).toBe('/dashboard/billing');
  expect(exchange).not.toHaveBeenCalled();
});

it('returns to sign-in on an expired code or connection failure', async () => {
  exchange.mockResolvedValueOnce({ error: new Error('Expired') });
  exchange.mockRejectedValueOnce(new Error('Offline'));
  for (let i = 0; i < 2; i++) {
    const result = await GET(new NextRequest('http://localhost/auth/callback?code=invalid'));
    expect(new URL(result.headers.get('location')!).searchParams.get('error')).toBe('auth_callback_failed');
  }
});

it('handles an incomplete callback', async () => {
  const result = await GET(new NextRequest('http://localhost/auth/callback'));
  expect(new URL(result.headers.get('location')!).searchParams.get('error')).toBe('missing_code');
  expect(exchange).not.toHaveBeenCalled();
});
