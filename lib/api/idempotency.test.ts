import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withIdempotency } from '@/lib/api/idempotency';

interface QueryResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

const state = vi.hoisted(() => ({
  insertError: null as { code?: string; message: string } | null,
  updateError: null as { message: string } | null,
  selectRow: null as unknown,
  selectError: null as { message: string } | null,
  deleteCalls: 0,
}));

interface FakeQuery extends PromiseLike<QueryResult> {
  select(): FakeQuery;
  insert(): FakeQuery;
  update(): FakeQuery;
  delete(): FakeQuery;
  eq(): FakeQuery;
  maybeSingle(): PromiseLike<QueryResult>;
}

function resolveFor(op: string): QueryResult {
  if (op === 'insert') return { data: null, error: state.insertError };
  if (op === 'update') return { data: null, error: state.updateError };
  if (op === 'delete') {
    state.deleteCalls += 1;
    return { data: null, error: null };
  }
  return { data: state.selectRow, error: state.selectError };
}

function makeQuery(op: string): FakeQuery {
  const query: FakeQuery = {
    select: () => makeQuery('select'),
    insert: () => makeQuery('insert'),
    update: () => makeQuery('update'),
    delete: () => makeQuery('delete'),
    eq: () => query,
    maybeSingle: () => Promise.resolve({ data: state.selectRow, error: state.selectError }),
    then: (onfulfilled, onrejected) => Promise.resolve(resolveFor(op)).then(onfulfilled, onrejected),
  };
  return query;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: () => makeQuery('root') }),
}));

describe('withIdempotency', () => {
  beforeEach(() => {
    state.insertError = null;
    state.updateError = null;
    state.selectRow = null;
    state.selectError = null;
    state.deleteCalls = 0;
  });

  it('runs exec once and persists a 2xx response', async () => {
    const exec = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    const outcome = await withIdempotency('u1', 'key-1', 'hash-a', exec);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: 200, body: { ok: true }, replay: false });
  });

  it('replays a stored completed response with a matching hash without running exec', async () => {
    state.insertError = { code: '23505', message: 'duplicate key' };
    state.selectRow = {
      request_hash: 'hash-a',
      status: 'completed',
      response_status: 201,
      response_body: { created: true },
    };

    const exec = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    const outcome = await withIdempotency('u1', 'key-1', 'hash-a', exec);

    expect(exec).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: 201, body: { created: true }, replay: true });
  });

  it('rejects a reused key with a different request body', async () => {
    state.insertError = { code: '23505', message: 'duplicate key' };
    state.selectRow = {
      request_hash: 'hash-other',
      status: 'completed',
      response_status: 200,
      response_body: {},
    };

    await expect(withIdempotency('u1', 'key-1', 'hash-a', async () => ({ status: 200, body: {} })))
      .rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
  });

  it('rejects a concurrent in-progress duplicate', async () => {
    state.insertError = { code: '23505', message: 'duplicate key' };
    state.selectRow = {
      request_hash: 'hash-a',
      status: 'in_progress',
      response_status: null,
      response_body: null,
    };

    await expect(withIdempotency('u1', 'key-1', 'hash-a', async () => ({ status: 200, body: {} })))
      .rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });
  });

  it('discards the reservation on a 5xx so the key can be retried', async () => {
    const exec = vi.fn(async () => ({ status: 502, body: { error: 'upstream' } }));
    const outcome = await withIdempotency('u1', 'key-1', 'hash-a', exec);

    expect(outcome).toEqual({ status: 502, body: { error: 'upstream' }, replay: false });
    expect(state.deleteCalls).toBe(1);
  });

  it('discards the reservation when exec throws', async () => {
    const exec = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(withIdempotency('u1', 'key-1', 'hash-a', exec)).rejects.toThrow('boom');
    expect(state.deleteCalls).toBe(1);
  });
});
