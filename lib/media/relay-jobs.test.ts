import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMediaJob, succeedJob } from './jobs';
import type { MediaChannelRow } from '@/lib/ai/channels';
import { MediaSubmissionError } from './fallback';

const state = vi.hoisted(() => ({ closed: false, channel: null as MediaChannelRow | null, enqueue: vi.fn(), after: undefined as undefined | (() => Promise<void>), updates: [] as Record<string, unknown>[], saved: null as unknown, generate: vi.fn(), hold: vi.fn(), settle: vi.fn(), release: vi.fn(), upload: vi.fn() }));
vi.mock('next/server', () => ({ after: (fn: () => Promise<void>) => { state.after = fn; } }));
vi.mock('@/lib/ai/sources', () => ({ loadRoutingPreferences: async () => new Map() }));
vi.mock('@/lib/ai/channels', () => ({ selectMediaChannel: async () => state.channel ?? ({ id: 'relay-image', provider: 'openai_images', modelId: 'gpt-image-2', baseUrl: 'https://relay.fast/v1', creditMultiplier: '1.5', requestPriceUsd: .01, billingPolicy: { imagePrices: { standard: .01, large: .02 } } }) }));
vi.mock('@/lib/admin/credentials', () => ({ resolvePlatformCreds: async (provider: string, baseUrl: string) => ({ provider, apiKey: 'test', baseUrl }) }));
vi.mock('@/lib/media/kie', () => ({ createImageTask: state.enqueue }));
vi.mock('@/lib/generate/ledger', () => ({ holdCredits: state.hold, settleCredits: state.settle, releaseCredits: state.release }));
vi.mock('@/lib/media/relay', async importOriginal => ({ ...await importOriginal<typeof import('./relay')>(), generateRelayImage: state.generate }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  from: () => {
    let inserted: Record<string, unknown> | null = null;
    const q = {
      insert: (row: Record<string, unknown>) => { inserted = row; return q; },
      update: (row: Record<string, unknown>) => { state.updates.push(row); if ('provider_result' in row) state.saved = row.provider_result; return q; },
      select: () => q, eq: () => q, in: () => q,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ error: null, data: inserted ? { ...inserted, id: 'job', upstream_task_id: null, status: 'queued', storage_path: null, error_code: null, error_message: null, credits_charged: null, created_at: new Date().toISOString(), completed_at: null } : { provider_result: state.saved } }),
      then: (fn: (value: unknown) => unknown) => Promise.resolve({ data: state.closed ? [] : [{ id: 'job' }], error: null }).then(fn),
    }; return q;
  },
  storage: { from: () => ({ upload: state.upload }) },
  rpc: state.settle,
}) }));

const input = { userId: 'test-user', apiKeyId: null, publicModelId: 'gpt-image-2', kind: 'image' as const, conversationId: null, input: { prompt: 'test', size: '2048x2048' }, planKey: 'free', log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), child: vi.fn() } };
beforeEach(() => {
  vi.clearAllMocks(); state.closed = false; state.channel = null; state.after = undefined; state.updates = []; state.saved = null; state.enqueue.mockResolvedValue('accepted-task');
  state.hold.mockResolvedValue({ success: true }); state.settle.mockResolvedValue({ error: null }); state.release.mockResolvedValue(undefined); state.upload.mockResolvedValue({ error: null });
  state.generate.mockResolvedValue({ data: [{ b64_json: Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64') }] });
});
afterEach(() => vi.unstubAllGlobals());
describe('Relay image lifecycle', () => {
  it('switches a refused Relay image to Kie in the background without another hold', async () => {
    const backup: MediaChannelRow = { id: 'kie-image', provider: 'kie_jobs', baseUrl: 'https://api.kie.ai/api/v1', modelId: 'same-model', creditMultiplier: '1', requestPriceUsd: .02 };
    state.channel = { ...backup, id: 'relay-image', provider: 'openai_images', baseUrl: 'https://relay.fast/v1', creditMultiplier: '1.5', billingPolicy: { origin: 'relay.fast', version: 'test', syncedAt: '2026-09-21T00:00:00Z', tiers: [{ name: 'standard', rates: { inputPerMTok: 0, outputPerMTok: 0, cachedPerMTok: 0 } }], imagePrices: { standard: .01, large: .02 } }, fallbackChannels: [backup] };
    state.generate.mockRejectedValueOnce(new MediaSubmissionError('no capacity', 503));
    await createMediaJob(input);
    expect(state.enqueue).not.toHaveBeenCalled();
    await state.after!();
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    expect(state.hold).toHaveBeenCalledTimes(1);
    expect(state.hold.mock.calls[0]![2]).toBe(300);
    expect(state.updates).toContainEqual(expect.objectContaining({ channel_id: 'kie-image', credit_multiplier: '1', credits_held: 200 }));
    expect(state.updates.at(-1)).toMatchObject({ upstream_task_id: 'accepted-task', status: 'running' });
    expect(state.release).not.toHaveBeenCalled();
  });

  it('stops before submission when another worker has already closed the job', async () => {
    state.closed = true;
    await expect(createMediaJob(input)).rejects.toThrow('media job has already closed');
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(state.after).toBeUndefined();
    expect(state.release).not.toHaveBeenCalled();
  });

  it('settles the serving provider actual charge and records the same amount', async () => {
    state.channel = { id: 'kie-image', provider: 'kie_jobs', baseUrl: 'https://api.kie.ai/api/v1', modelId: 'same-model', creditMultiplier: '1.5', requestPriceUsd: .04 };
    const job = await createMediaJob(input);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })));
    await succeedJob(job, { taskId: 'accepted-task', state: 'succeeded', imageUrl: 'https://results.example/image.png', errorCode: null, errorMessage: null, upstreamCredits: 2 }, input.log);
    expect(state.updates.at(-1)).toMatchObject({ status: 'succeeded', credits_charged: 150 });
    expect(state.settle).toHaveBeenCalledExactlyOnceWith(job.requestId, 150, expect.objectContaining({ kind: 'image', job_id: 'job' }));
  });

  it('Auto switches a refused submission to another provider and records the serving price', async () => {
    const backup: MediaChannelRow = { id: 'backup-image', provider: 'kie_jobs', baseUrl: 'https://backup.example/api/v1', modelId: 'same-model', creditMultiplier: '1.5', requestPriceUsd: .04 };
    state.channel = { ...backup, id: 'primary-image', baseUrl: 'https://api.kie.ai/api/v1', creditMultiplier: '1', requestPriceUsd: .02, fallbackChannels: [backup] };
    state.enqueue.mockRejectedValueOnce(new MediaSubmissionError('no capacity', 503)).mockResolvedValueOnce('backup-task');
    const job = await createMediaJob(input);
    expect(state.hold.mock.calls[0]![2]).toBe(600);
    expect(job).toMatchObject({ channelId: 'backup-image', creditMultiplier: '1.5', creditsHeld: 600, upstreamTaskId: 'backup-task', status: 'running' });
    expect(state.enqueue).toHaveBeenCalledTimes(2);
    expect(state.release).not.toHaveBeenCalled();
  });

  it('does not resubmit an accepted Kie job or a submission that times out', async () => {
    const backup: MediaChannelRow = { id: 'backup', provider: 'kie_jobs', baseUrl: 'https://backup.example/api/v1', modelId: 'same-model', creditMultiplier: '1', requestPriceUsd: .04 };
    state.channel = { ...backup, id: 'primary', fallbackChannels: [backup] };
    expect((await createMediaJob(input)).upstreamTaskId).toBe('accepted-task');
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    state.enqueue.mockClear().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
    await expect(createMediaJob(input)).rejects.toThrow('timeout');
    expect(state.enqueue).toHaveBeenCalledTimes(1);
  });

  it('reserves the size price, returns immediately, then stores and charges exactly once', async () => {
    const job = await createMediaJob(input);
    expect(job.status).toBe('running'); expect(state.generate).not.toHaveBeenCalled();
    expect(state.hold.mock.calls[0]![2]).toBe(300);
    await state.after!();
    expect(state.generate).toHaveBeenCalledTimes(1); expect(state.upload).toHaveBeenCalledTimes(1);
    expect(state.settle).toHaveBeenCalledWith('finish_relay_image', { p_job_id: 'job', p_storage_path: 'test-user/job.png' });
    expect(state.release).not.toHaveBeenCalled();
  });
  it('refunds an upstream failure without settlement', async () => {
    state.generate.mockRejectedValue(new Error('upstream unavailable'));
    await createMediaJob(input); await state.after!();
    expect(state.release).toHaveBeenCalledTimes(1); expect(state.settle).not.toHaveBeenCalled();
    expect(state.updates.at(-1)).toMatchObject({ status: 'failed', credits_charged: 0 });
  });
  it('keeps the generated result for a storage retry rather than paying for regeneration', async () => {
    state.upload.mockResolvedValue({ error: { message: 'storage unavailable' } });
    await createMediaJob(input); await state.after!();
    expect(state.saved).toBeTruthy(); expect(state.release).not.toHaveBeenCalled(); expect(state.settle).not.toHaveBeenCalled();
  });
});
