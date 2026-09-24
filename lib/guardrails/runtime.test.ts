import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { admitGeneration, boundedRequest, clientIpKey, enforceLocalPolicy, guardedRoute, observePolicyRejection, trackGeneration } from './runtime';
import { openAiErrorFrom } from '@/lib/api/openai-errors';

const state = vi.hoisted(() => ({ rpc: vi.fn(), after: [] as Array<() => Promise<void>> }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ rpc: state.rpc }) }));
vi.mock('next/server', () => ({ after: (fn: () => Promise<void>) => state.after.push(fn) }));
beforeEach(() => {
  state.after.length = 0;
  state.rpc.mockReset().mockResolvedValue({ data: { allowed: true }, error: null });
});
afterEach(() => vi.unstubAllEnvs());
const request = () => new Request('https://app.test/v1/chat/completions', { method: 'POST', body: '{}' });

describe('shared generation guard', () => {
  it('rejects suspended accounts before upstream work', async () => {
    state.rpc.mockResolvedValue({ data: { allowed: false, reason: 'inactive' }, error: null });
    const upstream = vi.fn();
    const route = guardedRoute(async () => { await admitGeneration('u'); upstream(); return new Response(); }, openAiErrorFrom);
    expect((await route(request())).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('returns Retry-After for concurrency rejection', async () => {
    state.rpc.mockResolvedValue({ data: { allowed: false, reason: 'concurrency', retry_after: 10 }, error: null });
    const route = guardedRoute(async () => { await admitGeneration('u'); return new Response(); }, openAiErrorFrom);
    const response = await route(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('10');
  });
  it('blocks generation if the shared guard database is unavailable', async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    const route = guardedRoute(async () => { await admitGeneration('u'); return new Response(); }, openAiErrorFrom);
    expect((await route(request())).status).toBe(503);
  });
  it('keeps a slot until generation completes, including after response/disconnect', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const route = guardedRoute(async () => { await admitGeneration('u'); trackGeneration(pending); return new Response('stream'); }, openAiErrorFrom);
    expect((await route(request())).status).toBe(200);
    const cleanup = state.after[0]!();
    await Promise.resolve();
    expect(state.rpc.mock.calls.filter(([name]) => name === 'guard_release')).toHaveLength(0);
    finish();
    await cleanup;
    expect(state.rpc.mock.calls.filter(([name]) => name === 'guard_release')).toHaveLength(1);
  });
  it('records one strike for a rejection observed more than once', async () => {
    const route = guardedRoute(async () => {
      await admitGeneration('u');
      await observePolicyRejection({ code: 'content_filter' });
      await observePolicyRejection({ code: 'content_filter' });
      return new Response();
    }, openAiErrorFrom);
    await route(request());
    expect(state.rpc.mock.calls.filter(([name]) => name === 'guard_record_violation')).toHaveLength(1);
  });
  it('blocks a local rule before provider dispatch with no moderation HTTP call', async () => {
    const upstream = vi.fn();
    const route = guardedRoute(async () => {
      await admitGeneration('u');
      await enforceLocalPolicy('Generate child pornography');
      upstream();
      return new Response();
    }, openAiErrorFrom);
    expect((await route(request())).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});
describe('request boundaries', () => {
  it('checks actual bytes even when Content-Length lies', async () => {
    const input = new Request('https://app.test', { method: 'POST', headers: { 'content-length': '1' }, body: '12345678' });
    await expect(boundedRequest(input, 4)).rejects.toMatchObject({ status: 413 });
  });
  it('preserves an accepted body', async () => {
    expect(await (await boundedRequest(request(), 20)).text()).toBe('{}');
  });
  it('ignores untrusted forwarded headers and hashes a trusted address', () => {
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('GUARD_TRUSTED_IP_HEADER', '');
    vi.stubEnv('GUARD_IP_HASH_KEY', 'test-secret');
    const req = new Request('https://app.test', { headers: { 'x-forwarded-for': '192.0.2.1' } });
    expect(clientIpKey(req)).toBeNull();
    vi.stubEnv('GUARD_TRUSTED_IP_HEADER', 'x-forwarded-for');
    expect(clientIpKey(req)).toMatch(/^[a-f0-9]{64}$/);
  });
});
