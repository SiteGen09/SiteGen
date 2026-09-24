import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres, { type TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';

import { parseUsageRange, parseUsageSort, usageMonitoring } from '@/lib/admin/usage-monitoring';

const databaseUrl = process.env.DATABASE_URL;
const local = databaseUrl && ['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname);

describe('usage monitoring filters', () => {
  it('bounds reporting windows and ranking dimensions', () => {
    expect(parseUsageRange('7d')).toBe('7d');
    expect(parseUsageRange('30d')).toBe('30d');
    expect(parseUsageSort('consumers')).toBe('consumers');
    expect(parseUsageSort('credits')).toBe('credits');
    expect(parseUsageSort('cost')).toBe('cost');
    expect(parseUsageSort('profit')).toBe('profit');
    for (const invalid of [undefined, ['30d', '7d'], 'all', '1; DROP TABLE channels']) {
      expect(parseUsageRange(invalid)).toBe('24h');
      expect(parseUsageSort(invalid)).toBe('requests');
    }
  });
});

async function transaction(check: (tx: TransactionSql) => Promise<void>) {
  const client = postgres(databaseUrl!, { max: 1 });
  const rollback = new Error('rollback monitoring fixtures');
  try {
    await expect(client.begin(async (tx) => {
      const existing = await tx.unsafe("SELECT to_regclass('public.usage_route_snapshots') AS name");
      if (!existing[0]?.name) {
        await tx.unsafe(await readFile('supabase/migrations/20260921110000_usage_route_monitoring.sql', 'utf8'));
      }
      await check(tx);
      throw rollback;
    })).rejects.toBe(rollback);
  } finally { await client.end(); }
}

async function isolatedTables(tx: TransactionSql) {
  // Actual Postgres aggregates, isolated from the developer's usage data.
  await tx.unsafe('CREATE TEMP TABLE usage_events (LIKE public.usage_events INCLUDING DEFAULTS) ON COMMIT DROP');
  await tx.unsafe('CREATE TEMP TABLE channels (LIKE public.channels INCLUDING DEFAULTS) ON COMMIT DROP');
  await tx.unsafe('CREATE TEMP TABLE usage_route_snapshots (LIKE public.usage_route_snapshots INCLUDING DEFAULTS) ON COMMIT DROP');
}

describe.skipIf(!local)('admin usage monitoring database', () => {
  it('returns an empty summary without manufacturing models or routes', async () => transaction(async (tx) => {
    await isolatedTables(tx);
    const data = await usageMonitoring('24h', 'requests', tx);
    expect(data.summary).toMatchObject({
      requests: 0, consumers: 0, errors: 0, credits: 0, cost_usd: 0,
      p95_latency_ms: null, missing_cost_requests: 0,
    });
    expect(data.models).toEqual([]);
    expect(data.routes).toEqual([]);
  }));

  it('counts unique consumers across serving routes and preserves unassigned outcomes and missing costs', async () => transaction(async (tx) => {
    await isolatedTables(tx);
    const first = randomUUID();
    const second = randomUUID();
    await tx.unsafe(
      "INSERT INTO channels (id,label,task,provider,model_id,public_model_id,input_per_mtok,output_per_mtok,cached_per_mtok) VALUES " +
      "('cheap','Changed label','chat.completions','openai_compatible','private','renamed-model',1,1,0)," +
      "('backup','Backup','chat.completions','openai_compatible','private','shared',1,1,0)," +
      "('image','Image','image.generate','openai_images','image','image',0,0,0)",
    );
    const events = [
      ['a', first, 'cheap', 'ok', 100, 50, 25, 100, 10, .001],
      ['b', first, 'cheap', 'ok', 200, 60, 25, 200, 20, .002],
      ['c', first, 'backup', 'ok', 300, 70, 25, 300, 30, .003],
      ['d', second, 'backup', 'failed', null, null, null, 999999, 0, null],
      ['e', second, 'image', 'ok', null, null, null, 400, 500, null],
      ['f', second, null, 'rejected', null, null, null, null, 0, null],
    ];
    for (const event of events) {
      await tx.unsafe(
        'INSERT INTO usage_events (request_id,user_id,channel_id,status,input_tokens,output_tokens,cached_tokens,latency_ms,credits_charged,cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        event,
      );
    }
    await tx.unsafe(
      "INSERT INTO usage_route_snapshots (request_id,model_id,channel_label,source_id,source_label,provider,task) VALUES " +
      "('a','shared','Original cheap label','s1','Source one','openai_compatible','chat.completions')," +
      "('b','shared','Original cheap label','s1','Source one','openai_compatible','chat.completions')," +
      "('c','shared','Backup','s2','Source two','openai_compatible','chat.completions')," +
      "('d','shared','Backup','s2','Source two','openai_compatible','chat.completions')," +
      "('e','image','Image','s3','Image source','openai_images','image.generate')",
    );
    const result = await usageMonitoring('24h', 'requests', tx);
    expect(result.summary).toMatchObject({
      requests: 6, consumers: 2, successful_requests: 4, errors: 2, credits: 560,
      cost_usd: .006, missing_cost_requests: 1, input_tokens: 600, output_tokens: 180,
      cached_tokens: 75, p95_latency_ms: 385, legacy_requests: 0,
    });
    expect(result.models[0]).toMatchObject({
      model_id: 'shared', requests: 4, consumers: 2, channel_id: null,
      channel_label: null, source_id: null, provider: null, p95_latency_ms: 290,
    });
    expect(result.models.some((row) => row.model_id === 'renamed-model')).toBe(false);
    expect(result.models.find((row) => row.model_id === null)).toMatchObject({ requests: 1, errors: 1 });
    expect(result.routes.find((row) => row.channel_id === 'cheap')).toMatchObject({
      model_id: 'shared', channel_label: 'Original cheap label', requests: 2, consumers: 1,
    });
    expect(result.routes.find((row) => row.channel_id === 'backup')).toMatchObject({
      requests: 2, consumers: 2, errors: 1, source_label: 'Source two',
    });
    expect(result.routes.reduce((sum, row) => sum + row.requests, 0)).toBe(result.summary.requests);
    expect(result.models.reduce((sum, row) => sum + row.requests, 0)).toBe(result.summary.requests);
    expect((await usageMonitoring('24h', 'credits', tx)).models[0]?.model_id).toBe('image');
    expect((await usageMonitoring('24h', 'cost', tx)).models[0]?.model_id).toBe('shared');
    expect((await usageMonitoring('24h', 'consumers', tx)).routes[0]?.channel_id).toBe('backup');

    // Explicitly exercise the inclusive start, exclusive outside, and future bounds.
    for (const [id, hours] of [['day', 24], ['week', 168], ['month', 720], ['outside', 721], ['future', -1]] as const) {
      await tx.unsafe(
        "INSERT INTO usage_events (request_id,user_id,channel_id,status,created_at) VALUES ($1,$2,'cheap','ok',now() - $3 * interval '1 hour')",
        [id, first, hours],
      );
    }
    expect((await usageMonitoring('24h', 'requests', tx)).summary.requests).toBe(7);
    expect((await usageMonitoring('7d', 'requests', tx)).summary.requests).toBe(8);
    const month = await usageMonitoring('30d', 'requests', tx);
    expect(month.summary.requests).toBe(9);
    const legacy = month.routes.find((row) => row.model_id === 'renamed-model');
    expect(legacy).toMatchObject({ requests: 3, legacy_requests: 3, source_id: null, source_label: null });
  }));

  it('captures history for all usage writers, preserves retries, updates reroutes, and denies consumer reads', async () => transaction(async (tx) => {
    const user = randomUUID();
    const id = 'usage-monitor-' + randomUUID();
    await tx.unsafe('INSERT INTO auth.users (id,email) VALUES ($1,$2)', [user, id + '@test.local']);
    await tx.unsafe(
      "INSERT INTO sources (id,family,label,credit_multiplier) VALUES ($1,'gpt','Original source',1)",
      [id],
    );
    await tx.unsafe(
      "INSERT INTO channels (id,label,task,provider,model_id,public_model_id,source_id,input_per_mtok,output_per_mtok,cached_per_mtok) " +
      "VALUES ($1,'Original channel','chat.completions','openai_compatible','private-model','public-model',$2,1,1,0), " +
      "($3,'Fallback channel','chat.completions','openai_compatible','private-backup','backup-model',$2,1,1,0)",
      [id, id, id + '-backup'],
    );
    // Mirrors media's explicit label, which must not replace the source snapshot.
    await tx.unsafe(
      "INSERT INTO usage_events (request_id,user_id,channel_id,status,source_label) VALUES ($1,$2,$3,'ok','image - public-model')",
      [id, user, id],
    );
    const snapshot = async () => (await tx.unsafe('SELECT * FROM usage_route_snapshots WHERE request_id=$1', [id]))[0];
    expect(await snapshot()).toMatchObject({
      model_id: 'public-model', channel_label: 'Original channel', source_label: 'Original source',
    });
    await tx.unsafe("UPDATE channels SET public_model_id='changed-model',label='Changed channel' WHERE id=$1", [id]);
    await tx.unsafe("UPDATE sources SET label='Changed source' WHERE id=$1", [id]);
    // PostgREST upsert conflict: changing catalog labels must not rewrite history.
    await tx.unsafe(
      "INSERT INTO usage_events (request_id,user_id,channel_id,status) VALUES ($1,$2,$3,'ok') " +
      'ON CONFLICT (request_id) DO UPDATE SET channel_id=EXCLUDED.channel_id,status=EXCLUDED.status',
      [id, user, id],
    );
    expect(await snapshot()).toMatchObject({
      model_id: 'public-model', channel_label: 'Original channel', source_label: 'Original source',
    });
    await tx.unsafe('UPDATE usage_events SET channel_id=$1 WHERE request_id=$2', [id + '-backup', id]);
    expect(await snapshot()).toMatchObject({ model_id: 'backup-model', channel_label: 'Fallback channel' });
    const privileges = await tx.unsafe(
      "SELECT has_table_privilege('authenticated','public.usage_route_snapshots','SELECT') AS consumer_read, " +
      "has_table_privilege('anon','public.usage_route_snapshots','SELECT') AS anon_read, " +
      "has_table_privilege('service_role','public.usage_route_snapshots','INSERT') AS service_write",
    );
    expect(privileges[0]).toMatchObject({ consumer_read: false, anon_read: false, service_write: true });
    await tx.unsafe("UPDATE usage_events SET channel_id=NULL,status='rejected' WHERE request_id=$1", [id]);
    expect(await snapshot()).toBeUndefined();
  }), 30000);
});
