import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.GUARD_TEST_DATABASE_URL;
describe.skipIf(!url)('database guardrails', () => {
  const sql = postgres(url ?? 'postgres://localhost', { max: 12 });
  const users: string[] = [];
  async function user() {
    const id = randomUUID();
    await sql.unsafe('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, id + '@guard.test']);
    users.push(id);
    return id;
  }
  async function admit(id: string, ip: string | null = null, rpm = 100, concurrency = 4) {
    const request = randomUUID();
    const [row] = await sql.unsafe('SELECT guard_admit($1::uuid, $2, $3, $4, 2, $5) AS result', [id, request, ip, rpm, concurrency]);
    return { request, ...row!.result } as { request: string; allowed: boolean; reason?: string };
  }
  beforeAll(() => {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url!).hostname)) throw new Error('Guard tests require a local database');
  });
  afterAll(async () => {
    for (const id of users) {
      await sql.unsafe('DELETE FROM guard_counters WHERE bucket = $1', ['user:' + id]);
      await sql.unsafe('DELETE FROM auth.users WHERE id = $1::uuid', [id]);
    }
    await sql.end();
  });
  it('admits only four simultaneous requests for one account', async () => {
    const id = await user();
    const results = await Promise.all(Array.from({ length: 10 }, () => admit(id)));
    expect(results.filter(r => r.allowed)).toHaveLength(4);
    expect(results.filter(r => !r.allowed).every(r => r.reason === 'concurrency')).toBe(true);
    await sql.unsafe('SELECT guard_release($1)', [results.find(r => r.allowed)!.request]);
    expect((await admit(id)).allowed).toBe(true);
  });
  it('counts account RPM across separate requests', async () => {
    const id = await user();
    expect((await admit(id, null, 1)).allowed).toBe(true);
    expect((await admit(id, null, 1)).reason).toBe('rate');
  });
  it('counts queued media once during its request and after its HTTP lease is released', async () => {
    const id = await user();
    const first = await admit(id, null, 100, 2);
    const [channel] = await sql.unsafe('SELECT id FROM channels LIMIT 1');
    expect(channel).toBeDefined();
    await sql.unsafe("INSERT INTO media_jobs(user_id, request_id, channel_id, public_model_id, kind, input, callback_token) VALUES ($1,$2,$3,'guard-test','image','{}','guard-test')", [id, first.request, channel!.id]);
    const second = await admit(id, null, 100, 2);
    expect(second.allowed).toBe(true);
    expect((await admit(id, null, 100, 2)).reason).toBe('concurrency');
    await sql.unsafe('SELECT guard_release($1)', [first.request]);
    expect((await admit(id, null, 100, 2)).reason).toBe('concurrency');
    await sql.unsafe("UPDATE media_jobs SET status='failed', completed_at=now() WHERE request_id=$1", [first.request]);
    expect((await admit(id, null, 100, 2)).allowed).toBe(true);
  });
  it('shares the IP budget across accounts', async () => {
    const ip = 'test-' + randomUUID();
    try {
      expect((await admit(await user(), ip)).allowed).toBe(true);
      expect((await admit(await user(), ip)).allowed).toBe(true);
      expect((await admit(await user(), ip)).reason).toBe('rate');
    } finally { await sql.unsafe('DELETE FROM guard_counters WHERE bucket = $1', ['ip:' + ip]); }
  });
  it('denies suspended accounts and expires abandoned leases', async () => {
    const id = await user();
    await sql.unsafe("UPDATE profiles SET status = 'suspended' WHERE id = $1", [id]);
    expect((await admit(id)).reason).toBe('inactive');
    await sql.unsafe("UPDATE profiles SET status = 'active' WHERE id = $1", [id]);
    await sql.unsafe("INSERT INTO guard_leases VALUES ($1, $2, now() - interval '1 second')", [randomUUID(), id]);
    expect((await admit(id, null, 100, 1)).allowed).toBe(true);
  });
  it('deduplicates strikes and enforces an expiring cooldown', async () => {
    const id = await user();
    const request = randomUUID();
    for (let i = 0; i < 3; i++) await sql.unsafe("SELECT guard_record_violation($1::uuid, $2, 'provider/content-policy', 2, 3600)", [id, request]);
    const [count] = await sql.unsafe('SELECT count(*)::int AS n FROM guard_violations WHERE user_id = $1', [id]);
    expect(count!.n).toBe(1);
    await sql.unsafe("SELECT guard_record_violation($1::uuid, $2, 'provider/content-policy', 2, 3600)", [id, randomUUID()]);
    expect((await admit(id)).reason).toBe('cooldown');
    await sql.unsafe("UPDATE guard_cooldowns SET blocked_until = now() - interval '1 second' WHERE user_id = $1", [id]);
    expect((await admit(id)).allowed).toBe(true);
  });
  it('denies public access to guard RPCs and tables', async () => {
    const [row] = await sql.unsafe("SELECT has_function_privilege('anon', 'guard_admit(uuid,text,text,integer,integer,integer)', 'EXECUTE') AS rpc, has_table_privilege('authenticated', 'guard_leases', 'INSERT') AS write");
    expect(row).toMatchObject({ rpc: false, write: false });
  });
});
