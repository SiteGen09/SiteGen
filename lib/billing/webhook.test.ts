import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as reconcileGET } from '@/app/api/cron/reconcile/route';
import { POST } from '@/app/api/webhooks/whop/route';
import { verifyWhopSignature } from '@/lib/billing/whop';

/**
 * Webhook contract tests. The fake service client is an in-memory store with
 * the two constraints this flow leans on: `billing_events.event_id` primary key
 * (delivery dedupe) and `ledger.request_id` unique (grant dedupe). Both report
 * Postgres 23505 on collision, which is the path the route treats as
 * "already processed".
 */

type Row = Record<string, unknown>;

interface QueryError {
  code?: string;
  message: string;
}

interface QueryResult<T> {
  data: T;
  error: QueryError | null;
}

const UNIQUE_VIOLATION = '23505';

/** Unique/primary key per table, mirroring the migrations. */
const UNIQUE_KEYS: Record<string, string> = {
  profiles: 'id',
  entitlements: 'user_id',
  ledger: 'request_id',
  billing_events: 'event_id',
};

class FakeDb {
  private readonly tables = new Map<string, Row[]>();
  readonly writes: string[] = [];

  rows(table: string): Row[] {
    const existing = this.tables.get(table);
    if (existing !== undefined) return existing;
    const created: Row[] = [];
    this.tables.set(table, created);
    return created;
  }

  setRows(table: string, rows: Row[]): void {
    this.tables.set(table, rows);
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  writeCount(op: string): number {
    return this.writes.filter((entry) => entry === op).length;
  }

  seedProfile(id: string, email: string): void {
    this.rows('profiles').push({ id, email });
  }

  seedEntitlement(row: Row): void {
    this.rows('entitlements').push(row);
  }

  entitlement(userId: string): Row | undefined {
    return this.rows('entitlements').find((row) => row['user_id'] === userId);
  }

  ledger(kind: string): Row[] {
    return this.rows('ledger').filter((row) => row['kind'] === kind);
  }

  get client(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

class FakeQuery implements PromiseLike<QueryResult<Row[]>> {
  private mode: 'select' | 'delete' | 'update' = 'select';
  private patch: Row | null = null;
  private readonly filters: Array<[string, unknown]> = [];
  private max: number | null = null;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(_columns?: string): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push([column, value]);
    return this;
  }

  limit(count: number): this {
    this.max = count;
    return this;
  }

  delete(): this {
    this.mode = 'delete';
    return this;
  }

  update(row: Row): this {
    this.mode = 'update';
    this.patch = row;
    return this;
  }

  private matches(): Row[] {
    return this.db
      .rows(this.table)
      .filter((row) => this.filters.every(([column, value]) => row[column] === value));
  }

  maybeSingle(): Promise<QueryResult<Row | null>> {
    const found = this.matches();
    if (found.length > 1) {
      return Promise.resolve({ data: null, error: { message: 'multiple rows returned' } });
    }
    return Promise.resolve({ data: found[0] ?? null, error: null });
  }

  insert(row: Row): Promise<QueryResult<null>> {
    this.db.writes.push(`${this.table}.insert`);
    const key = UNIQUE_KEYS[this.table];
    const rows = this.db.rows(this.table);
    if (key !== undefined && rows.some((existing) => existing[key] === row[key])) {
      return Promise.resolve({
        data: null,
        error: {
          code: UNIQUE_VIOLATION,
          message: `duplicate key value violates unique constraint "${this.table}_pkey"`,
        },
      });
    }
    rows.push({ ...row });
    return Promise.resolve({ data: null, error: null });
  }

  upsert(row: Row, options?: { onConflict?: string }): Promise<QueryResult<null>> {
    this.db.writes.push(`${this.table}.upsert`);
    const key = options?.onConflict ?? UNIQUE_KEYS[this.table] ?? 'id';
    const rows = this.db.rows(this.table);
    const index = rows.findIndex((existing) => existing[key] === row[key]);
    if (index === -1) rows.push({ ...row });
    else rows[index] = { ...rows[index], ...row };
    return Promise.resolve({ data: null, error: null });
  }

  then<TResult1 = QueryResult<Row[]>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<Row[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    if (this.mode === 'update') {
      this.db.writes.push(`${this.table}.update`);
      const patch = this.patch ?? {};
      for (const row of this.matches()) Object.assign(row, patch);
      return Promise.resolve<QueryResult<Row[]>>({ data: [], error: null }).then(
        onfulfilled,
        onrejected,
      );
    }
    if (this.mode === 'delete') {
      this.db.writes.push(`${this.table}.delete`);
      const kept = this.db
        .rows(this.table)
        .filter((row) => !this.filters.every(([column, value]) => row[column] === value));
      this.db.setRows(this.table, kept);
      return Promise.resolve<QueryResult<Row[]>>({ data: [], error: null }).then(
        onfulfilled,
        onrejected,
      );
    }
    const found = this.matches();
    return Promise.resolve<QueryResult<Row[]>>({
      data: this.max === null ? found : found.slice(0, this.max),
      error: null,
    }).then(onfulfilled, onrejected);
  }
}

const holder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => {
    if (holder.current === null) throw new Error('fake service client was not installed');
    return holder.current;
  },
}));

vi.mock('@/lib/log', () => {
  const make = (): unknown => ({
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => make(),
  });
  return { logger: () => make() };
});

const SECRET = 'whsec_test_secret';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'dev@example.com';
const PLAN_STARTER = 'plan_starter_test';
const PLAN_PRO = 'plan_pro_test';
const PLAN_TOPUP = 'plan_topup_test';
const API_KEY = 'whop_api_key_test';
const CRON_SECRET = 'cron_secret_test';

let db: FakeDb;

function signature(rawBody: string, webhookId: string, timestamp: string, secret: string): string {
  const digest = createHmac('sha256', secret)
    .update(`${webhookId}.${timestamp}.${rawBody}`, 'utf8')
    .digest('base64');
  return `v1,${digest}`;
}

function webhookRequest(
  event: Row,
  overrides: {
    secret?: string;
    body?: string;
    signed?: boolean;
    /** Unix seconds to send (and sign) instead of "now" — replay window tests. */
    timestamp?: string;
  } = {},
): Request {
  const rawBody = JSON.stringify(event);
  const webhookId = `msg_${String(event['id'])}`;
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers = new Headers({ 'content-type': 'application/json' });
  if (overrides.signed !== false) {
    headers.set('webhook-id', webhookId);
    headers.set('webhook-timestamp', timestamp);
    headers.set(
      'webhook-signature',
      signature(rawBody, webhookId, timestamp, overrides.secret ?? SECRET),
    );
  }
  return new Request('https://app.test/api/webhooks/whop', {
    method: 'POST',
    headers,
    // `body` lets a test send bytes the signature does not cover.
    body: overrides.body ?? rawBody,
  });
}

function membershipEvent(options: {
  eventId: string;
  type: string;
  membershipId?: string;
  planId?: string;
  status?: string;
  periodEnd?: string | null;
  metadata?: Row | null;
  email?: string | null;
}): Row {
  return {
    id: options.eventId,
    type: options.type,
    api_version_date: '2026-08-14',
    timestamp: new Date().toISOString(),
    account_id: 'biz_test',
    data: {
      id: options.membershipId ?? 'mem_1',
      status: options.status ?? 'active',
      plan_id: options.planId ?? PLAN_STARTER,
      user_id: 'user_whop_1',
      user: { id: 'user_whop_1', email: options.email ?? null },
      current_period_end: options.periodEnd ?? null,
      metadata: options.metadata === undefined ? { userId: USER_ID } : options.metadata,
    },
  };
}

function paymentEvent(options: {
  eventId: string;
  type: string;
  paymentId?: string;
  planId?: string;
  membershipId?: string | null;
  metadata?: Row | null;
}): Row {
  return {
    id: options.eventId,
    type: options.type,
    api_version_date: '2026-08-14',
    timestamp: new Date().toISOString(),
    account_id: 'biz_test',
    data: {
      id: options.paymentId ?? 'pay_1',
      status: options.type.includes('failed') ? 'failed' : 'succeeded',
      plan_id: options.planId ?? PLAN_STARTER,
      membership_id: options.membershipId ?? 'mem_1',
      user: { id: 'user_whop_1', email: null },
      metadata: options.metadata === undefined ? { userId: USER_ID } : options.metadata,
    },
  };
}

async function post(request: Request): Promise<{ status: number; body: Row }> {
  const response = await POST(request);
  const body: unknown = await response.json();
  return { status: response.status, body: body as Row };
}

/** A REST membership row as List/Retrieve Memberships returns it. */
function membershipRow(options: {
  id: string;
  planId?: string;
  status?: string;
  periodEnd?: string | null;
  metadata?: Row | null;
  email?: string | null;
}): Row {
  return {
    id: options.id,
    status: options.status ?? 'active',
    plan_id: options.planId ?? PLAN_STARTER,
    user_id: 'user_whop_1',
    user: { id: 'user_whop_1', email: options.email ?? null },
    current_period_end: options.periodEnd ?? null,
    metadata: options.metadata === undefined ? { userId: USER_ID } : options.metadata,
  };
}

/**
 * Stands in for the Whop REST API: `pages` is keyed by billing status for
 * List Memberships, `byId` serves Retrieve Membership.
 */
function stubWhopApi(stub: { pages?: Record<string, Row[]>; byId?: Record<string, Row> }): {
  paths: string[];
} {
  const paths: string[] = [];
  const handler = (input: unknown): Promise<Response> => {
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const url = new URL(href);
    paths.push(`${url.pathname}${url.search}`);

    const single = /\/memberships\/([^/?]+)$/.exec(url.pathname);
    if (single !== null) {
      const row = stub.byId?.[single[1] as string];
      if (row === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
      return Promise.resolve(Response.json(row));
    }
    const status = url.searchParams.get('status') ?? '';
    return Promise.resolve(
      Response.json({
        data: stub.pages?.[status] ?? [],
        page_info: { end_cursor: null, has_next_page: false },
      }),
    );
  };
  vi.stubGlobal('fetch', vi.fn(handler));
  return { paths };
}

async function reconcile(secret: string | null): Promise<{ status: number; body: Row }> {
  const headers = new Headers();
  if (secret !== null) headers.set('authorization', `Bearer ${secret}`);
  const response = await reconcileGET(
    new Request('https://app.test/api/cron/reconcile', { headers }),
  );
  const body: unknown = await response.json();
  return { status: response.status, body: body as Row };
}

beforeEach(() => {
  db = new FakeDb();
  db.seedProfile(USER_ID, EMAIL);
  holder.current = db.client;

  process.env.WHOP_WEBHOOK_SECRET = SECRET;
  process.env.WHOP_PLAN_STARTER = PLAN_STARTER;
  process.env.WHOP_PLAN_PRO = PLAN_PRO;
  process.env.WHOP_PLAN_TOPUP = PLAN_TOPUP;
  process.env.WHOP_API_KEY = API_KEY;
  process.env.CRON_SECRET = CRON_SECRET;
  delete process.env.WHOP_ACCOUNT_ID;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyWhopSignature', () => {
  const body = '{"id":"evt_1"}';
  const meta = { webhookId: 'msg_1', timestamp: '1700000000' };

  it('accepts a signature over webhook-id.webhook-timestamp.body', () => {
    const header = signature(body, meta.webhookId, meta.timestamp, SECRET);
    expect(verifyWhopSignature(body, header, SECRET, meta)).toBe(true);
  });

  it('accepts one valid pair among several versioned candidates', () => {
    const header = `v0,ZmFrZQ== ${signature(body, meta.webhookId, meta.timestamp, SECRET)}`;
    expect(verifyWhopSignature(body, header, SECRET, meta)).toBe(true);
  });

  it('rejects a signature made with another secret', () => {
    const header = signature(body, meta.webhookId, meta.timestamp, 'other_secret');
    expect(verifyWhopSignature(body, header, SECRET, meta)).toBe(false);
  });

  it('rejects a body that changed after signing', () => {
    const header = signature(body, meta.webhookId, meta.timestamp, SECRET);
    expect(verifyWhopSignature('{"id":"evt_2"}', header, SECRET, meta)).toBe(false);
  });

  it('rejects an absent header', () => {
    expect(verifyWhopSignature(body, null, SECRET, meta)).toBe(false);
    expect(verifyWhopSignature(body, '', SECRET, meta)).toBe(false);
  });
});

describe('POST /api/webhooks/whop signature gate', () => {
  it('rejects an unsigned delivery with 401 and stores nothing', async () => {
    const event = membershipEvent({ eventId: 'evt_unsigned', type: 'membership.activated' });
    const { status } = await post(webhookRequest(event, { signed: false }));

    expect(status).toBe(401);
    expect(db.rows('billing_events')).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });

  it('rejects a delivery signed with the wrong secret', async () => {
    const event = membershipEvent({ eventId: 'evt_badsig', type: 'membership.activated' });
    const { status } = await post(webhookRequest(event, { secret: 'not_our_secret' }));

    expect(status).toBe(401);
    expect(db.writes).toHaveLength(0);
  });

  it('rejects a body tampered with after signing, before parsing it', async () => {
    const event = membershipEvent({ eventId: 'evt_tampered', type: 'membership.activated' });
    const tampered = JSON.stringify(
      membershipEvent({ eventId: 'evt_tampered', type: 'membership.activated', planId: PLAN_PRO }),
    );
    const { status } = await post(webhookRequest(event, { body: tampered }));

    expect(status).toBe(401);
    expect(db.entitlement(USER_ID)).toBeUndefined();
  });
});

describe('POST /api/webhooks/whop delivery dedupe', () => {
  it('acks a repeated event_id without reprocessing it', async () => {
    const event = membershipEvent({
      eventId: 'evt_dupe',
      type: 'membership.activated',
      periodEnd: '2026-10-01T00:00:00.000Z',
    });

    const first = await post(webhookRequest(event));
    const second = await post(webhookRequest(event));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body['duplicate']).toBe(true);
    expect(db.writeCount('entitlements.upsert')).toBe(1);
    expect(db.ledger('grant')).toHaveLength(1);
  });
});

describe('POST /api/webhooks/whop membership transitions', () => {
  it('activates an entitlement on a valid membership', async () => {
    const event = membershipEvent({
      eventId: 'evt_valid',
      type: 'membership.went_valid',
      planId: PLAN_PRO,
      periodEnd: '2026-10-01T00:00:00.000Z',
    });

    const { status, body } = await post(webhookRequest(event));

    expect(status).toBe(200);
    expect(body['handled']).toBe(true);
    expect(db.entitlement(USER_ID)).toMatchObject({
      user_id: USER_ID,
      plan_key: 'pro',
      status: 'active',
      external_id: 'mem_1',
      current_period_end: '2026-10-01T00:00:00.000Z',
      monthly_credits: 2_500_000,
      provider: 'whop',
    });
  });

  it('keeps access active while a membership is canceling at period end', async () => {
    const event = membershipEvent({
      eventId: 'evt_canceling',
      type: 'membership.went_valid',
      planId: PLAN_PRO,
      status: 'canceling',
      periodEnd: '2026-10-01T00:00:00.000Z',
    });

    const { status } = await post(webhookRequest(event));

    expect(status).toBe(200);
    expect(db.entitlement(USER_ID)).toMatchObject({
      plan_key: 'pro',
      status: 'active',
      current_period_end: '2026-10-01T00:00:00.000Z',
    });
  });

  it('deactivates on an invalid membership while keeping plan_key for history', async () => {
    db.seedEntitlement({
      user_id: USER_ID,
      plan_key: 'pro',
      status: 'active',
      external_id: 'mem_1',
      current_period_end: '2026-10-01T00:00:00.000Z',
      monthly_credits: 2_500_000,
    });

    const event = membershipEvent({
      eventId: 'evt_invalid',
      type: 'membership.went_invalid',
      planId: PLAN_PRO,
      status: 'canceled',
    });
    const { status } = await post(webhookRequest(event));

    expect(status).toBe(200);
    expect(db.entitlement(USER_ID)).toMatchObject({
      plan_key: 'pro',
      status: 'inactive',
      current_period_end: '2026-10-01T00:00:00.000Z',
      monthly_credits: 2_500_000,
    });
    expect(db.ledger('grant')).toHaveLength(0);
  });

  it('moves an entitlement to past_due on a failed payment', async () => {
    db.seedEntitlement({
      user_id: USER_ID,
      plan_key: 'starter',
      status: 'active',
      external_id: 'mem_1',
      current_period_end: '2026-10-01T00:00:00.000Z',
      monthly_credits: 500_000,
    });

    const event = paymentEvent({ eventId: 'evt_failed', type: 'payment.failed' });
    const { status } = await post(webhookRequest(event));

    expect(status).toBe(200);
    expect(db.entitlement(USER_ID)).toMatchObject({
      plan_key: 'starter',
      status: 'past_due',
      monthly_credits: 500_000,
    });
  });

  it('leaves the entitlement untouched for a plan id we do not sell', async () => {
    const event = membershipEvent({
      eventId: 'evt_unknown_plan',
      type: 'membership.activated',
      planId: 'plan_someone_elses_product',
      periodEnd: '2026-10-01T00:00:00.000Z',
    });

    const { status, body } = await post(webhookRequest(event));

    expect(status).toBe(200);
    expect(body['handled']).toBe(false);
    expect(db.writeCount('entitlements.upsert')).toBe(0);
    expect(db.rows('billing_events')).toHaveLength(1);
  });

  it('stores the event without guessing a user when no metadata or email links one', async () => {
    const event = membershipEvent({
      eventId: 'evt_unmapped',
      type: 'membership.activated',
      metadata: null,
      email: null,
      periodEnd: '2026-10-01T00:00:00.000Z',
    });

    const { status, body } = await post(webhookRequest(event));

    expect(status).toBe(200);
    expect(body['handled']).toBe(false);
    expect(db.writeCount('entitlements.upsert')).toBe(0);
    expect(db.rows('ledger')).toHaveLength(0);
  });

  it('links by unique email when checkout metadata is missing', async () => {
    const event = membershipEvent({
      eventId: 'evt_email_link',
      type: 'membership.activated',
      metadata: null,
      email: EMAIL,
      periodEnd: '2026-10-01T00:00:00.000Z',
    });

    const { status } = await post(webhookRequest(event));

    expect(status).toBe(200);
    expect(db.entitlement(USER_ID)).toMatchObject({ plan_key: 'starter', status: 'active' });
  });
});

describe('POST /api/webhooks/whop credit grants', () => {
  it('grants the monthly allotment once per period, then dedupes on request_id', async () => {
    const periodEnd = '2026-10-01T00:00:00.000Z';
    const first = await post(
      webhookRequest(
        membershipEvent({ eventId: 'evt_grant_1', type: 'membership.activated', periodEnd }),
      ),
    );
    expect(first.status).toBe(200);

    // Same period, a different delivery id: passes the event dedupe and has to
    // be stopped by the unique `ledger.request_id`.
    const replay = await post(
      webhookRequest(
        membershipEvent({ eventId: 'evt_grant_1_replay', type: 'membership.activated', periodEnd }),
      ),
    );
    expect(replay.status).toBe(200);

    const grants = db.ledger('grant');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      user_id: USER_ID,
      request_id: `whop-renewal-mem_1-${periodEnd}`,
      kind: 'grant',
      credits: 500_000,
    });
  });

  it('grants again when the period end moves forward', async () => {
    await post(
      webhookRequest(
        membershipEvent({
          eventId: 'evt_period_1',
          type: 'membership.activated',
          periodEnd: '2026-10-01T00:00:00.000Z',
        }),
      ),
    );
    await post(
      webhookRequest(
        membershipEvent({
          eventId: 'evt_period_2',
          type: 'membership.activated',
          periodEnd: '2026-11-01T00:00:00.000Z',
        }),
      ),
    );

    const grants = db.ledger('grant');
    expect(grants).toHaveLength(2);
    expect(grants.map((row) => row['request_id'])).toEqual([
      'whop-renewal-mem_1-2026-10-01T00:00:00.000Z',
      'whop-renewal-mem_1-2026-11-01T00:00:00.000Z',
    ]);
    expect(db.entitlement(USER_ID)).toMatchObject({
      current_period_end: '2026-11-01T00:00:00.000Z',
    });
  });

  it('does not grant for a stale period end below the stored one', async () => {
    db.seedEntitlement({
      user_id: USER_ID,
      plan_key: 'starter',
      status: 'active',
      external_id: 'mem_1',
      current_period_end: '2026-11-01T00:00:00.000Z',
      monthly_credits: 500_000,
    });

    await post(
      webhookRequest(
        membershipEvent({
          eventId: 'evt_stale',
          type: 'membership.activated',
          periodEnd: '2026-10-01T00:00:00.000Z',
        }),
      ),
    );

    expect(db.rows('ledger')).toHaveLength(0);
  });

  it('credits a top-up purchase once per payment id', async () => {
    const topup = paymentEvent({
      eventId: 'evt_topup',
      type: 'payment.succeeded',
      planId: PLAN_TOPUP,
      paymentId: 'pay_topup_1',
      membershipId: null,
    });
    const { status, body } = await post(webhookRequest(topup));

    expect(status).toBe(200);
    expect(body['handled']).toBe(true);

    const replay = paymentEvent({
      eventId: 'evt_topup_replay',
      type: 'payment.succeeded',
      planId: PLAN_TOPUP,
      paymentId: 'pay_topup_1',
      membershipId: null,
    });
    await post(webhookRequest(replay));

    const topups = db.ledger('topup');
    expect(topups).toHaveLength(1);
    expect(topups[0]).toMatchObject({
      user_id: USER_ID,
      request_id: 'whop-topup-pay_topup_1',
      kind: 'topup',
      credits: 100_000,
    });
    expect(db.writeCount('entitlements.upsert')).toBe(0);
  });
});

describe('replay window', () => {
  it('rejects a correctly signed delivery whose timestamp is outside the tolerance', async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const { status } = await post(
      webhookRequest(
        membershipEvent({ eventId: 'evt_stale', type: 'membership.went_valid' }),
        { timestamp: stale },
      ),
    );

    expect(status).toBe(401);
    expect(db.rows('billing_events')).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
  });
});

describe('subscription payment renewal', () => {
  it('re-reads the membership from the API and grants the new period once', async () => {
    db.seedEntitlement({
      user_id: USER_ID,
      plan_key: 'starter',
      status: 'active',
      provider: 'whop',
      external_id: 'mem_1',
      current_period_end: '2026-10-01T00:00:00.000Z',
      monthly_credits: 500_000,
    });
    const api = stubWhopApi({
      byId: {
        mem_1: membershipRow({ id: 'mem_1', periodEnd: '2026-11-01T00:00:00.000Z' }),
      },
    });

    const event = paymentEvent({ eventId: 'evt_pay_ok', type: 'payment.succeeded' });
    const first = await post(webhookRequest(event));
    expect(first.status).toBe(200);
    expect(first.body['handled']).toBe(true);
    expect(api.paths).toContain('/api/v1/memberships/mem_1');

    const grants = db.ledger('grant');
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      request_id: 'whop-renewal-mem_1-2026-11-01T00:00:00.000Z',
      credits: 500_000,
    });
    expect(db.entitlement(USER_ID)).toMatchObject({
      status: 'active',
      current_period_end: '2026-11-01T00:00:00.000Z',
    });

    // A distinct event id for the same period must not grant twice: the ledger
    // request_id is derived from the period end, so the unique index stops it.
    const replay = await post(
      webhookRequest(paymentEvent({ eventId: 'evt_pay_ok_2', type: 'payment.succeeded' })),
    );
    expect(replay.status).toBe(200);
    expect(db.ledger('grant')).toHaveLength(1);
  });

  it('skips the grant when the membership read fails', async () => {
    stubWhopApi({ byId: {} });

    const { status, body } = await post(
      webhookRequest(
        paymentEvent({ eventId: 'evt_pay_unreadable', type: 'payment.succeeded' }),
      ),
    );

    expect(status).toBe(200);
    expect(body['handled']).toBe(false);
    expect(db.rows('ledger')).toHaveLength(0);
    expect(db.writeCount('entitlements.upsert')).toBe(0);
  });
});

describe('reconciliation', () => {
  it('rejects a request without the cron bearer token', async () => {
    const { status } = await reconcile(null);
    expect(status).toBe(401);

    const wrong = await reconcile('nope');
    expect(wrong.status).toBe(401);
    expect(db.writes).toHaveLength(0);
  });

  it('repairs drift against the memberships Whop reports as entitled', async () => {
    db.seedEntitlement({
      user_id: USER_ID,
      plan_key: 'starter',
      status: 'past_due',
      provider: 'whop',
      external_id: 'mem_1',
      current_period_end: '2026-09-01T00:00:00.000Z',
      monthly_credits: 500_000,
    });
    stubWhopApi({
      pages: {
        active: [
          membershipRow({ id: 'mem_1', planId: PLAN_PRO, periodEnd: '2026-10-01T00:00:00.000Z' }),
          // Another product of the same account: outside our plan ids, ignored.
          membershipRow({ id: 'mem_other', planId: 'plan_not_ours' }),
        ],
      },
    });

    const { status, body } = await reconcile(CRON_SECRET);

    expect(status).toBe(200);
    expect(body['checked']).toBe(1);
    expect(body['repaired']).toBe(1);
    expect(db.entitlement(USER_ID)).toMatchObject({
      plan_key: 'pro',
      status: 'active',
      external_id: 'mem_1',
      current_period_end: '2026-10-01T00:00:00.000Z',
      monthly_credits: 2_500_000,
    });
    expect(db.rows('ledger')).toHaveLength(0);
  });

  it('leaves a matching entitlement untouched', async () => {
    db.seedEntitlement({
      user_id: USER_ID,
      plan_key: 'starter',
      status: 'active',
      provider: 'whop',
      external_id: 'mem_1',
      current_period_end: '2026-10-01T00:00:00.000Z',
      monthly_credits: 500_000,
    });
    stubWhopApi({
      pages: {
        active: [membershipRow({ id: 'mem_1', periodEnd: '2026-10-01T00:00:00.000Z' })],
      },
    });

    const { body } = await reconcile(CRON_SECRET);

    expect(body['checked']).toBe(1);
    expect(body['repaired']).toBe(0);
    expect(db.writeCount('entitlements.upsert')).toBe(0);
  });

  it('deactivates an entitlement Whop no longer reports as entitled', async () => {
    db.seedEntitlement({
      user_id: USER_ID,
      plan_key: 'pro',
      status: 'active',
      provider: 'whop',
      external_id: 'mem_gone',
      current_period_end: '2026-10-01T00:00:00.000Z',
      monthly_credits: 2_000_000,
    });
    stubWhopApi({ pages: {} });

    const { body } = await reconcile(CRON_SECRET);

    expect(body['repaired']).toBe(1);
    expect(db.entitlement(USER_ID)).toMatchObject({
      plan_key: 'pro',
      status: 'inactive',
    });
  });
});
