import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from './route';

const state = vi.hoisted(() => ({
  writes: [] as Array<{ table: string; operation: string; value: Record<string, unknown> }>,
  rpc: vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: { allowed: true }, error: null })),
  after: [] as Array<() => Promise<void>>,
}));

interface QueryResult { data: unknown; error: null }
interface Query extends PromiseLike<QueryResult> {
  select(): Query;
  eq(): Query;
  or(): Query;
  order(): Query;
  limit(): Query;
  single(): Promise<QueryResult>;
  maybeSingle(): Promise<QueryResult>;
  insert(value: Record<string, unknown>): Query;
  update(value: Record<string, unknown>): Query;
  upsert(value: Record<string, unknown>): Query;
}

function query(table: string): Query {
  const result: QueryResult = {
    data: table === 'profiles' ? { status: 'active' }
      : table === 'chat_messages' ? [] : { id: 'conversation' },
    error: null,
  };
  function write(operation: string, value: Record<string, unknown>): Query {
    state.writes.push({ table, operation, value });
    return builder;
  }
  const builder: Query = {
    select: () => builder,
    eq: () => builder,
    or: () => builder,
    order: () => builder,
    limit: () => builder,
    single: async () => result,
    maybeSingle: async () => result,
    insert: (value) => write('insert', value),
    update: (value) => write('update', value),
    upsert: (value) => write('upsert', value),
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
    prepareCall: async () => ({
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
    }),
  };
});

const upstream = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"OK"}}]}',
  'data: {"choices":[]}',
  'data: {"choices":[],"usage":{"prompt_tokens":84,"completion_tokens":1,"total_tokens":213}}',
].join('\n\n') + '\n\n';

beforeEach(() => {
  state.writes.length = 0;
  state.after.length = 0;
  state.rpc.mockClear();
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
    expect(body).toContain('The upstream response ended early.');
    expect(state.rpc.mock.calls.filter(([name]) => name === 'release_credits')).toHaveLength(1);
    expect(state.rpc).toHaveBeenCalledWith('release_credits', expect.any(Object));
    expect(state.writes.filter((write) => write.table === 'usage_events')).toEqual([
      expect.objectContaining({ value: expect.objectContaining({ status: 'failed', credits_charged: 0 }) }),
    ]);
    expect(state.writes.some((write) => write.table === 'chat_messages' && write.value.role === 'assistant'))
      .toBe(false);
  });
});
