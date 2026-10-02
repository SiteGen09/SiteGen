import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaJob } from './jobs';
import { MEDIA_OUTPUT_REFUSAL } from '@/lib/safety/media-policy-text';

const state = vi.hoisted(() => ({
  verdict: vi.fn(),
  upload: vi.fn(),
  release: vi.fn(),
  settle: vi.fn(),
  updates: [] as Record<string, unknown>[],
}));

vi.mock('next/server', () => ({ after: () => undefined }));
vi.mock('@/lib/safety/media-gate', () => ({ screenMediaOutput: state.verdict, screenMediaRequest: vi.fn() }));
vi.mock('@/lib/generate/ledger', () => ({ holdCredits: vi.fn(), settleCredits: state.settle, releaseCredits: state.release }));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: () => {
      const q = {
        update: (row: Record<string, unknown>) => { state.updates.push(row); return q; },
        upsert: async () => ({ error: null }),
        select: () => q, eq: () => q, in: () => q,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (fn: (value: unknown) => unknown) => Promise.resolve({ data: [{ id: 'job-1' }], error: null }).then(fn),
      };
      return q;
    },
    storage: { from: () => ({ upload: state.upload }) },
  }),
}));

const { succeedJob } = await import('./jobs');
const { SafetyUnavailableError } = await import('@/lib/safety/media-classifier');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as never;
const job = (createdAt = new Date().toISOString()): MediaJob => ({
  id: 'job-1', userId: 'user-1', requestId: 'req-1', channelId: 'c', publicModelId: 'm', kind: 'image', conversationId: null,
  upstreamTaskId: 'task', status: 'running', storagePath: null, errorCode: null, errorMessage: null, creditMultiplier: '1',
  creditsHeld: 10, creditsCharged: null, createdAt, completedAt: null, expiredAt: null,
});
const record = { taskId: 'task', state: 'succeeded' as const, imageUrl: 'https://cdn.test/out.png', errorCode: null, errorMessage: null, upstreamCredits: null };

beforeEach(() => {
  vi.clearAllMocks();
  state.updates = [];
  state.upload.mockResolvedValue({ error: null });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })));
});
afterEach(() => vi.unstubAllGlobals());

describe('finished render screening', () => {
  it('stores and settles a result that passes', async () => {
    state.verdict.mockResolvedValue('allow');
    await succeedJob(job(), record, log);
    expect(state.upload).toHaveBeenCalledTimes(1);
    expect(state.updates.at(-1)).toMatchObject({ status: 'succeeded' });
    expect(state.settle).toHaveBeenCalled();
  });

  it('never stores a blocked result, fails the job with the refusal, and returns the credits', async () => {
    state.verdict.mockResolvedValue('block');
    await succeedJob(job(), record, log);
    expect(state.upload).not.toHaveBeenCalled();
    expect(state.updates).toContainEqual(expect.objectContaining({ status: 'failed', error_code: 'content_policy_violation', error_message: MEDIA_OUTPUT_REFUSAL }));
    expect(state.release).toHaveBeenCalledWith('req-1');
    expect(state.settle).not.toHaveBeenCalled();
  });

  it('leaves the job open for the next sweep while the safety check is down', async () => {
    state.verdict.mockRejectedValue(new SafetyUnavailableError());
    await succeedJob(job(), record, log);
    expect(state.upload).not.toHaveBeenCalled();
    expect(state.updates.some((row) => row.status !== undefined)).toBe(false);
  });

  it('drops the result once the safety check has been down past the deadline', async () => {
    state.verdict.mockRejectedValue(new SafetyUnavailableError());
    await succeedJob(job(new Date(Date.now() - 31 * 60_000).toISOString()), record, log);
    expect(state.upload).not.toHaveBeenCalled();
    expect(state.updates).toContainEqual(expect.objectContaining({ status: 'failed', error_code: 'safety_check_unavailable' }));
  });
});
