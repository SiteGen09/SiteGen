import { expect, it, vi } from 'vitest';
import { handleCreate } from './handlers';
import { createMediaJob } from './jobs';
vi.mock('@/lib/guardrails/runtime', () => ({ admitGeneration: vi.fn() }));
vi.mock('@/lib/api/api-key-auth', () => ({
  authenticateApiKey: async () => ({ apiKeyId: 'key', ownerId: 'user', rateLimitRpm: 1 }),
  requireScope: vi.fn(),
}));
vi.mock('@/lib/generate/ledger', () => ({ consumeRateLimit: async () => ({ allowed: false, retryAfterSeconds: 37 }) }));
vi.mock('@/lib/media/jobs', () => ({ createMediaJob: vi.fn() }));

it('rejects over-limit media requests before creating or dispatching a job', async () => {
  const response = await handleCreate(new Request('https://app.test/v1/images', { method: 'POST', body: '{}' }), 'image');
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('37');
  expect(createMediaJob).not.toHaveBeenCalled();
});
