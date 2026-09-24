import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  loadJob: vi.fn(),
  refreshMediaJob: vi.fn(),
  signedUrlFor: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock('@/lib/media/jobs', () => ({
  loadJob: mocks.loadJob,
  refreshMediaJob: mocks.refreshMediaJob,
  signedUrlFor: mocks.signedUrlFor,
  SIGNED_URL_TTL_SECONDS: 3600,
}));

const job = {
  id: 'job', userId: 'owner', kind: 'image', status: 'succeeded',
  createdAt: '2026-09-21T00:00:00Z', publicModelId: 'seedream',
  creditsCharged: 375, errorCode: null,
};
const read = (query = '') => GET(
  new Request(`https://app.test/api/media/job${query}`),
  { params: Promise.resolve({ id: 'job' }) },
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'owner' } }, error: null });
  mocks.loadJob.mockResolvedValue(job);
  mocks.refreshMediaJob.mockResolvedValue(job);
  mocks.signedUrlFor.mockResolvedValue('https://storage.test/fresh-image.png?download=generated-job.png');
});

describe('media preview and download', () => {
  it('requires a session before accessing a download', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect((await read('?download=1')).status).toBe(401);
    expect(mocks.loadJob).not.toHaveBeenCalled();
  });

  it('does not refresh or sign another user’s image', async () => {
    mocks.loadJob.mockResolvedValue({ ...job, userId: 'someone-else' });
    expect((await read('?download=1')).status).toBe(404);
    expect(mocks.refreshMediaJob).not.toHaveBeenCalled();
    expect(mocks.signedUrlFor).not.toHaveBeenCalled();
  });

  it('creates a fresh attachment URL for the owner without caching the redirect', async () => {
    const response = await read('?download=1');
    expect(response.status).toBe(302);
    expect(mocks.signedUrlFor).toHaveBeenCalledWith(job, true);
    expect(response.headers.get('location')).toContain('download=generated-job.png');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('does not download an unfinished image', async () => {
    mocks.refreshMediaJob.mockResolvedValue({ ...job, status: 'running' });
    expect((await read('?download=1')).status).toBe(409);
    expect(mocks.signedUrlFor).not.toHaveBeenCalled();
  });

  it('reports a storage signing failure instead of redirecting to a broken URL', async () => {
    mocks.signedUrlFor.mockResolvedValue(null);
    expect((await read('?download=1')).status).toBe(502);
  });

  it('refreshes an in-progress job before returning its image in a normal poll', async () => {
    const running = { ...job, status: 'running' };
    mocks.loadJob.mockResolvedValue(running);
    const response = await read();
    expect(mocks.refreshMediaJob).toHaveBeenCalledWith(running, expect.any(Object));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'succeeded', url: expect.any(String) });
    expect(mocks.signedUrlFor).toHaveBeenCalledWith(job);
  });
});
