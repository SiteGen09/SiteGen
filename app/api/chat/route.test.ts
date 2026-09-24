import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/errors';
import { POST } from './route';

const state = vi.hoisted(() => ({
  writes: [] as Array<{ table: string; operation: string; value: Record<string, unknown> }>,
  rpc: vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: { allowed: true }, error: null })),
  after: [] as Array<() => Promise<void>>,
  history: [] as Array<Record<string, unknown>>,
  prepareCall: vi.fn(),
}));

interface QueryResult { data: unknown; error: null }
interface Query extends PromiseLike<QueryResult> {
  select(): Query;
  eq(): Query;
  or(): Query;
  order(): Query;
  limit(): Query;
  gte(column: string, value: unknown): Query;
  single(): Promise<QueryResult>;
  maybeSingle(): Promise<QueryResult>;
  insert(value: Record<string, unknown>): Query;
  update(value: Record<string, unknown>): Query;
  upsert(value: Record<string, unknown>): Query;
  delete(): Query;
}

function query(table: string): Query {
  const result: QueryResult = {
    data: table === 'profiles' ? { status: 'active' }
      : table === 'chat_messages' ? state.history : { id: 'conversation' },
    error: null,
  };
  let written: Record<string, unknown> | undefined;
  function write(operation: string, value: Record<string, unknown>): Query {
    written = { ...value };
    state.writes.push({ table, operation, value: written });
    return builder;
  }
  const builder: Query = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    order: () => builder,
    limit: () => builder,
    gte: (column, value) => {
      if (written) written[column + '>='] = value;
      return builder;
    },
    single: async () => result,
    maybeSingle: async () => result,
    insert: (value) => write('insert', value),
    update: (value) => write('update', value),
    upsert: (value) => write('upsert', value),
    delete: () => write('delete', {}),
    then: (fulfilled, rejected) => Promise.resolve(result).then(fulfilled, rejected),
  };
  return builder;
}

vi.mock('next/server', () => ({
  after: (callback: () => Promise<void>) => { state.after.push(callback); },
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'owner' } }, error: null }) },
    from: query,
  }),
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: query, rpc: state.rpc }),
}));
vi.mock('@/lib/log', () => ({
  logger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/lib/chat/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/pipeline')>();
  return {
    ...actual,
    // Preflight is unrelated to the streaming bug. The route, SDK, pricing,
    // settlement and usage-event code all run against stubbed external I/O.
    prepareCall: state.prepareCall,
  };
});

function accepted() {
  return {
    ok: true,
    held: true,
    requestedMax: 64,
    resolved: {
      start: {
        id: 'kie-chat', provider: 'openai_compatible', baseUrl: 'https://api.kie.ai/v1',
        modelId: 'gemini-3-5-flash-openai', isByok: false, creditMultiplier: '1',
        status: 'active', fallbackTo: null,
        rates: { inputPerMTok: 1, outputPerMTok: 5, cachedPerMTok: 0.1 },
      },
      resolve: async () => null,
      buildCreds: async () => ({
        provider: 'openai_compatible', apiKey: 'test-key', baseUrl: 'https://api.kie.ai/v1',
      }),
    },
  };
}

const upstream = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"OK"}}]}',
  'data: {"choices":[]}',
  'data: {"choices":[],"usage":{"prompt_tokens":84,"completion_tokens":1,"total_tokens":213}}',
].join('\n\n') + '\n\n';

beforeEach(() => {
  state.writes.length = 0;
  state.after.length = 0;
  state.history = [];
  state.rpc.mockClear();
  state.prepareCall.mockReset();
  state.prepareCall.mockImplementation(async () => accepted());
});
afterEach(() => { vi.unstubAllGlobals(); });

async function requestChat(done: boolean, extra: Record<string, unknown> = {}): Promise<string> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(upstream + (done ? 'data: [DONE]\n\n' : ''), {
    headers: { 'content-type': 'text/event-stream' },
  })));
  const response = await POST(new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'public-gemini', content: 'Reply with OK', ...extra }),
  }));
  expect(response.status).toBe(200);
  const body = await response.text();
  for (const callback of state.after) await callback();
  return body;
}

describe('dashboard chat settlement after a Kie stream', () => {
  it('delivers text files and images upstream and saves them for later turns', async () => {
    const attachments = [
      { kind: 'text', name: 'notes.txt', text: 'Launch on Friday.' },
      { kind: 'image', name: 'pixel.png', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=' },
    ];
    await requestChat(true, { attachments });
    const sent = vi.mocked(fetch).mock.calls[0]?.[1]?.body;
    expect(String(sent)).toContain('Launch on Friday.');
    expect(String(sent)).toContain('image_url');
    expect(String(sent)).toContain('data:image/png;base64,');
    expect(state.writes).toContainEqual(expect.objectContaining({
      table: 'chat_messages', operation: 'insert',
      value: expect.objectContaining({ role: 'user', content: expect.stringContaining('[[chat-attachments:v1]]') }),
    }));
  });

  it('rejects unsupported attachments without starting upstream work', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await POST(new Request('http://localhost/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'public-gemini', content: 'Review', attachments: [{ kind: 'video', name: 'clip.mp4', data: 'bad' }] }),
    }));
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(0);
  });

  it('saves the answer, settles tokens and records success once Kie sends DONE', async () => {
    const body = await requestChat(true);
    expect(body).toContain('"content":"OK"');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).not.toContain('"error"');
    expect(body).toContain('data: [DONE]');
    expect(state.rpc.mock.calls.filter(([name]) => name === 'settle_credits')).toHaveLength(1);
    expect(state.rpc).toHaveBeenCalledWith('settle_credits', expect.objectContaining({
      p_actual_credits: 1,
      p_meta: { input_tokens: 84, output_tokens: 1, cached_tokens: 0 },
    }));
    expect(state.writes.filter((write) => write.table === 'usage_events')).toEqual([
      expect.objectContaining({ value: expect.objectContaining({
        status: 'ok', input_tokens: 84, output_tokens: 1, credits_charged: 1,
      }) }),
    ]);
    expect(state.writes).toContainEqual(expect.objectContaining({
      table: 'chat_messages', operation: 'insert',
      value: expect.objectContaining({ role: 'assistant', content: 'OK', tokens: 1 }),
    }));
  });

  it('releases the hold and records failure when the same response is cut off before DONE', async () => {
    const body = await requestChat(false);
    expect(body).toContain('"title":"Reply interrupted"');
    expect(body).toContain('You were not charged for this reply.');
    expect(state.rpc.mock.calls.filter(([name]) => name === 'release_credits')).toHaveLength(1);
    expect(state.rpc).toHaveBeenCalledWith('release_credits', expect.any(Object));
    expect(state.writes.filter((write) => write.table === 'usage_events')).toEqual([
      expect.objectContaining({ value: expect.objectContaining({ status: 'failed', credits_charged: 0 }) }),
    ]);
    expect(state.writes.some((write) => write.table === 'chat_messages' && write.value.role === 'assistant'))
      .toBe(false);
  });
});

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function post(extra: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return POST(new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'public-gemini', content: 'Reply with OK', ...extra }),
    ...(signal ? { signal } : {}),
  }));
}

function shortfall() {
  return {
    ok: false,
    response: { status: 402, body: {} },
    error: new ApiError('insufficient_credits', 'insufficient credits: need 1200, balance 35', 402, { required: 1200, balance: 35 }),
  };
}

describe('dashboard chat errors people can act on', () => {
  it('explains a credit shortfall with the figures and discards the empty new chat', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    state.prepareCall.mockResolvedValueOnce(shortfall());
    const response = await post({});
    expect(response.status).toBe(402);
    const { error } = await response.json();
    expect(error).toMatchObject({ kind: 'credits', title: 'Not enough credits', code: 'insufficient_credits' });
    expect(error.message).toContain('needs up to 1,200 credits, but your balance is 35');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.writes).toContainEqual(expect.objectContaining({ table: 'chat_conversations', operation: 'delete' }));
    expect(state.writes.some((write) => write.table === 'chat_messages')).toBe(false);
  });

  it('words an invalid body without validator jargon', async () => {
    const response = await post({ content: 'x'.repeat(32001) });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({
      kind: 'request', message: 'Messages can be up to 32,000 characters.',
    });
  });

  it('returns the saved message ids so the turn can be edited later', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(upstream + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    })));
    const response = await post({});
    await response.text();
    for (const callback of state.after) await callback();
    const promptId = response.headers.get('x-user-message-id');
    const replyId = response.headers.get('x-assistant-message-id');
    expect(promptId).toMatch(uuid);
    expect(replyId).toMatch(uuid);
    expect(state.writes).toContainEqual(expect.objectContaining({
      table: 'chat_messages', operation: 'insert', value: expect.objectContaining({ id: promptId, role: 'user' }),
    }));
    expect(state.writes).toContainEqual(expect.objectContaining({
      table: 'chat_messages', operation: 'insert', value: expect.objectContaining({ id: replyId, role: 'assistant' }),
    }));
  });
});

describe('stopping a reply', () => {
  it('stops the upstream, keeps the partial reply and bills an estimate for it', async () => {
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      upstreamSignal = signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Partial answer"}}]}\n\n',
          ));
          // Never finishes on its own: only the abort ends this reply.
          signal?.addEventListener('abort', () => controller.error(signal.reason));
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }));
    const browser = new AbortController();
    const response = await post({}, browser.signal);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let seen = '';
    while (!seen.includes('Partial answer')) seen += new TextDecoder().decode((await reader.read()).value);
    browser.abort();
    await reader.cancel();
    for (const callback of state.after) await callback();

    expect(upstreamSignal?.aborted).toBe(true);
    // 13 prompt characters and 14 streamed characters, at ~4 per token.
    expect(state.rpc).toHaveBeenCalledWith('settle_credits', expect.objectContaining({
      p_meta: { input_tokens: 4, output_tokens: 4, cached_tokens: 0, estimated: true },
    }));
    expect(state.rpc.mock.calls.some(([name]) => name === 'release_credits')).toBe(false);
    expect(state.writes).toContainEqual(expect.objectContaining({
      table: 'chat_messages', operation: 'insert',
      value: expect.objectContaining({
        id: response.headers.get('x-assistant-message-id'), role: 'assistant', content: 'Partial answer', tokens: 4,
      }),
    }));
    expect(state.writes.filter((write) => write.table === 'usage_events')).toEqual([
      expect.objectContaining({ value: expect.objectContaining({ status: 'ok', output_tokens: 4 }) }),
    ]);
  });

  it('saves and charges nothing when the browser leaves before the reply starts', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const browser = new AbortController();
    state.prepareCall.mockImplementationOnce(async () => {
      browser.abort();
      return accepted();
    });
    const response = await post({}, browser.signal);
    expect(response.status).toBe(499);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.rpc).toHaveBeenCalledWith('release_credits', expect.any(Object));
    expect(state.writes).toContainEqual(expect.objectContaining({ table: 'chat_conversations', operation: 'delete' }));
    expect(state.writes.some((write) => write.table === 'chat_messages' || write.table === 'usage_events')).toBe(false);
  });
});

describe('editing a message', () => {
  const conversationId = '5f0c7c7e-8f0a-4d7e-9a53-3f7a8f2f4b10';
  const turn = (n: number, role: string, content: string, at: string) => ({
    id: 'a1b2c3d4-0000-4000-8000-00000000000' + n, role, content, model: 'public-gemini', tokens: null, created_at: at,
  });
  const edited = turn(3, 'user', 'Old wording', '2026-09-24T10:01:00.000001+00:00');
  // The route reads newest first.
  const history = () => [
    turn(4, 'assistant', 'Stale answer', '2026-09-24T10:01:05+00:00'),
    edited,
    turn(2, 'assistant', 'First answer', '2026-09-24T10:00:05+00:00'),
    turn(1, 'user', 'First question', '2026-09-24T10:00:00+00:00'),
  ];

  it('replaces the edited turn and everything after it once the new turn is accepted', async () => {
    state.history = history();
    await requestChat(true, { conversationId, replaceFrom: edited.id, content: 'New wording' });
    const sent = String(vi.mocked(fetch).mock.calls[0]?.[1]?.body);
    for (const kept of ['First question', 'First answer', 'New wording']) expect(sent).toContain(kept);
    for (const dropped of ['Old wording', 'Stale answer']) expect(sent).not.toContain(dropped);
    const removal = state.writes.findIndex((write) => write.table === 'chat_messages' && write.operation === 'delete');
    const prompt = state.writes.findIndex((write) => write.table === 'chat_messages' && write.value.role === 'user');
    expect(state.writes[removal]?.value).toEqual({ 'created_at>=': edited.created_at });
    expect(removal).toBeLessThan(prompt);
  });

  it('leaves the conversation untouched when the edit is refused', async () => {
    state.history = history();
    vi.stubGlobal('fetch', vi.fn());
    state.prepareCall.mockResolvedValueOnce(shortfall());
    const response = await post({ conversationId, replaceFrom: edited.id, content: 'New wording' });
    expect(response.status).toBe(402);
    expect(state.writes.some((write) => write.table === 'chat_messages' || write.operation === 'delete')).toBe(false);
  });

  it('asks for a reload when the edited message is no longer there', async () => {
    state.history = history();
    const response = await post({ conversationId, replaceFrom: 'a1b2c3d4-0000-4000-8000-000000000099', content: 'x' });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({
      kind: 'request', message: expect.stringContaining('can no longer be edited'),
    });
  });
});
