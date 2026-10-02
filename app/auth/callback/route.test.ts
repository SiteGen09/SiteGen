import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from './route';

const { exchange, claim } = vi.hoisted(() => ({ exchange: vi.fn(), claim: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { exchangeCodeForSession: exchange } }) }));
vi.mock('@/lib/referrals/referrals', () => ({ claimReferral: claim }));
beforeEach(() => { exchange.mockReset(); exchange.mockResolvedValue({ error: null }); claim.mockReset(); });

it('exchanges an OAuth code and redirects to the requested local page', async () => {
  const result = await GET(new NextRequest('http://localhost/auth/callback?code=valid&next=%2Fdashboard%2Fbilling'));
  expect(exchange).toHaveBeenCalledWith('valid');
  expect(result.headers.get('location')).toBe('http://localhost/dashboard/billing');
});

it('redirects to the public host behind the tunnel, not the listen address', async () => {
  const result = await GET(new NextRequest('http://localhost:3000/auth/callback?code=valid&next=%2Fdashboard', {
    headers: { 'x-forwarded-host': 'gensite.tech', 'x-forwarded-proto': 'https' },
  }));
  expect(result.headers.get('location')).toBe('https://gensite.tech/dashboard');
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

it('claims a referral cookie for the signed-in user and clears it', async () => {
  exchange.mockResolvedValueOnce({ data: { user: { id: '00000000-0000-4000-8000-000000000001' } }, error: null });
  const request = new NextRequest('http://localhost/auth/callback?code=valid', { headers: { cookie: 'sg_ref=ABCD2345' } });
  const result = await GET(request);
  expect(claim).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', 'ABCD2345');
  expect(result.headers.get('set-cookie')).toMatch(/sg_ref=;/);
});
