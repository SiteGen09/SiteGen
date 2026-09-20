import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkContent } from '@/lib/moderation/check';
import { getModerationProvider, resetModerationWarning } from '@/lib/moderation/provider';
import { openAiModeration } from '@/lib/moderation/openai';
import type { Logger } from '@/lib/log';

function fakeLog() {
  const calls: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
  const log = {
    info: (msg: string, fields?: Record<string, unknown>) => calls.push({ level: 'info', msg, fields }),
    warn: (msg: string, fields?: Record<string, unknown>) => calls.push({ level: 'warn', msg, fields }),
    error: (msg: string, fields?: Record<string, unknown>) =>
      calls.push({ level: 'error', msg, fields }),
    child: () => log,
  } as unknown as Logger;
  return { log, calls };
}

beforeEach(() => {
  resetModerationWarning();
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('getModerationProvider', () => {
  it('warns once per process when the key is unset, then allows', async () => {
    vi.stubEnv('MODERATION_API_KEY', '');
    const { log, calls } = fakeLog();

    const first = getModerationProvider(log);
    const second = getModerationProvider(log);

    expect(await first.check('anything')).toEqual({ flagged: false, categories: [] });
    expect(await second.check('anything')).toEqual({ flagged: false, categories: [] });
    // One warning across both calls, not one per call.
    expect(calls.filter((c) => c.msg === 'moderation.key_missing')).toHaveLength(1);
  });
});

describe('checkContent fail-open', () => {
  it('allows and alerts when the provider throws', async () => {
    vi.stubEnv('MODERATION_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const { log, calls } = fakeLog();

    const result = await checkContent('hello', log);

    expect(result).toEqual({ flagged: false, categories: [] });
    const alert = calls.find((c) => c.msg === 'moderation.unavailable');
    expect(alert?.level).toBe('error');
    expect(alert?.fields?.alert).toBe(true);
  });

  it('allows and alerts on a moderation timeout', async () => {
    vi.stubEnv('MODERATION_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }),
    );
    const { log, calls } = fakeLog();

    const result = await checkContent('hello', log);

    expect(result.flagged).toBe(false);
    expect(calls.some((c) => c.msg === 'moderation.unavailable' && c.fields?.alert === true)).toBe(
      true,
    );
  });

  it('passes a clean provider result through', async () => {
    vi.stubEnv('MODERATION_API_KEY', 'test-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          results: [{ flagged: false, categories: { violence: false, hate: false } }],
        }),
      ),
    );
    const { log } = fakeLog();

    expect(await checkContent('hello', log)).toEqual({ flagged: false, categories: [] });
  });
});

describe('openAiModeration', () => {
  it('reports flagged categories, sorted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          results: [
            {
              flagged: true,
              categories: { violence: true, hate: true, sexual: false },
            },
          ],
        }),
      ),
    );

    const result = await openAiModeration('test-key').check('bad text');
    expect(result.flagged).toBe(true);
    expect(result.categories).toEqual(['hate', 'violence']);
  });

  it('throws on a non-2xx so the route can fail open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(openAiModeration('test-key').check('x')).rejects.toThrow(/HTTP 500/);
  });
});