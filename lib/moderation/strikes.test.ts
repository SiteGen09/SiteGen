import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordStrikeAndMaybeSuspend } from '@/lib/moderation/strikes';
import type { Logger } from '@/lib/log';

const state = vi.hoisted(() => ({
  rpcCount: 0 as number,
  rpcError: null as { message: string } | null,
  updatedRows: [] as unknown[],
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    rpc: async () => ({ data: state.rpcCount, error: state.rpcError }),
    from: () => {
      const q = {
        update: () => q,
        eq: () => q,
        select: async () => ({ data: state.updatedRows, error: null }),
      };
      return q;
    },
  }),
}));

function fakeLog() {
  const calls: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const log = {
    info() {},
    warn() {},
    error: (msg: string, fields?: Record<string, unknown>) => calls.push({ msg, fields }),
    child: () => log,
  } as unknown as Logger;
  return { log, calls };
}

beforeEach(() => {
  state.rpcCount = 0;
  state.rpcError = null;
  state.updatedRows = [];
  vi.unstubAllEnvs();
});

afterEach(() => vi.restoreAllMocks());

describe('recordStrikeAndMaybeSuspend', () => {
  it('does not suspend below the threshold', async () => {
    vi.stubEnv('ABUSE_STRIKE_THRESHOLD', '5');
    state.rpcCount = 4;

    const { log, calls } = fakeLog();
    const result = await recordStrikeAndMaybeSuspend('u1', 'r1', ['violence'], log);

    expect(result).toEqual({ strikeCount: 4, suspended: false });
    expect(calls).toHaveLength(0);
  });

  it('suspends and alerts at the threshold', async () => {
    vi.stubEnv('ABUSE_STRIKE_THRESHOLD', '5');
    state.rpcCount = 5;
    state.updatedRows = [{ id: 'u1' }];

    const { log, calls } = fakeLog();
    const result = await recordStrikeAndMaybeSuspend('u1', 'r1', ['violence'], log);

    expect(result).toEqual({ strikeCount: 5, suspended: true });
    expect(calls[0]?.msg).toBe('abuse.auto_suspended');
    expect(calls[0]?.fields?.alert).toBe(true);
  });

  it('does not re-alert when the user was already suspended', async () => {
    vi.stubEnv('ABUSE_STRIKE_THRESHOLD', '5');
    state.rpcCount = 9;
    // status='active' guard matched nothing: already suspended.
    state.updatedRows = [];

    const { log, calls } = fakeLog();
    const result = await recordStrikeAndMaybeSuspend('u1', 'r1', ['violence'], log);

    expect(result.suspended).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('falls back to the default threshold on a bad env value', async () => {
    vi.stubEnv('ABUSE_STRIKE_THRESHOLD', 'not-a-number');
    state.rpcCount = 5; // default threshold is 5
    state.updatedRows = [{ id: 'u1' }];

    const { log } = fakeLog();
    const result = await recordStrikeAndMaybeSuspend('u1', 'r1', [], log);
    expect(result.suspended).toBe(true);
  });

  it('throws when the strike RPC fails', async () => {
    state.rpcError = { message: 'boom' };
    const { log } = fakeLog();
    await expect(recordStrikeAndMaybeSuspend('u1', 'r1', [], log)).rejects.toThrow(
      /record_abuse_strike failed/,
    );
  });
});