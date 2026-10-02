import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatStreamParams, ChatStreamPart } from '@/lib/chat/stream';
import { POST } from './route';

const state = vi.hoisted(() => ({
  settleCall: vi.fn(async (_input: Record<string, unknown>) => ({ creditsCharged: 7, costUsd: 0.01 })),
  recordCallFailure: vi.fn(async (_input: Record<string, unknown>) => undefined),
  streamChat: vi.fn(),
}));

vi.mock('@/lib/guardrails/runtime', () => ({
  guardedRoute: (handler: (req: Request) => Promise<Response>) => handler,
  admitGeneration: async () => undefined,
  GATEWAY_MAX_BODY_BYTES: 1024 * 1024,
}));
vi.mock('@/lib/api/api-key-auth', () => ({
  authenticateApiKey: async () => ({ ownerId: 'owner', apiKeyId: 'key', rateLimitRpm: 60 }),
  requireScope: () => undefined,
}));
vi.mock('@/lib/generate/ledger', () => ({
  consumeRateLimit: async () => ({ allowed: true }),
  getBalance: async () => 100,
}));
vi.mock('@/lib/log', () => ({
  logger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/lib/chat/stream', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/stream')>()),
  streamChat: state.streamChat,
}));
vi.mock('@/lib/chat/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/pipeline')>()),
  prepareCall: async () => ({
    ok: true,
    resolved: { start: { id: 'channel-a' }, resolve: async () => null, buildCreds: async () => ({}) },
    requestedMax: 1_000,
    held: true,
  }),
  settleCall: state.settleCall,
  recordCallFailure: state.recordCallFailure,
  recordRequestFailure: async () => undefined,
}));

const CHANNEL = { id: 'channel-a', creditMultiplier: '1.5', isByok: false, rates: { inputPerMTok: 1, outputPerMTok: 4, cachedPerMTok: 0.1 } };

/** An upstream that streams `text`, then waits until the caller aborts it. */
function stalledUpstream(text: string) {
  state.streamChat.mockImplementation(async (params: ChatStreamParams) => {
    const signal = params.abortSignal!;
    const aborted = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    async function* parts(): AsyncGenerator<ChatStreamPart> {
      yield { type: 'text', text };
      await aborted;
    }
    const completion = aborted.then(() => { throw signal.reason; });
    completion.catch(() => undefined);
    return { channel: CHANNEL, partStream: parts(), completion };
  });
}

function request(): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
    // 400 characters of prompt: 100 estimated input tokens.
    body: JSON.stringify({ model: 'gensite-v1', stream: true, messages: [{ role: 'user', content: 'x'.repeat(400) }] }),
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('POST /v1/chat/completions streaming cancellation', () => {
  beforeEach(() => {
    state.settleCall.mockClear();
    state.recordCallFailure.mockClear();
    state.streamChat.mockReset();
  });

  it('stops the upstream and bills the prompt and the output already generated', async () => {
    stalledUpstream('y'.repeat(80));
    const response = await POST(request());
    const reader = response.body!.getReader();
    await reader.read();
    await reader.read();

    await reader.cancel();
    await flush();

    const params = state.streamChat.mock.calls[0]![0] as ChatStreamParams;
    expect(params.abortSignal!.aborted).toBe(true);
    expect(state.settleCall).toHaveBeenCalledTimes(1);
    expect(state.settleCall.mock.calls[0]![0]).toMatchObject({
      channelId: 'channel-a',
      held: true,
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0 },
    });
    expect(state.recordCallFailure).not.toHaveBeenCalled();
  });

  it('releases the hold when a cancelled turn cannot be settled', async () => {
    stalledUpstream('partial');
    state.settleCall.mockRejectedValueOnce(new Error('ledger down'));
    const response = await POST(request());
    const reader = response.body!.getReader();
    await reader.read();

    await reader.cancel();
    await flush();

    expect(state.recordCallFailure).toHaveBeenCalledTimes(1);
  });
});
