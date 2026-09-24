import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres, { type TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';

import { recentRequests, topConsumers, usageMonitoring } from '@/lib/admin/usage-monitoring';
import { userAccount, userCreditHistory } from '@/lib/admin/user-monitoring';

const databaseUrl = process.env.DATABASE_URL;
const local = databaseUrl && ['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname);

async function transaction(check: (tx: TransactionSql) => Promise<void>) {
  const client = postgres(databaseUrl!, { max: 1 });
  const rollback = new Error('rollback user monitoring fixtures');
  try {
    await expect(client.begin(async (tx) => {
      await check(tx);
      throw rollback;
    })).rejects.toBe(rollback);
  } finally { await client.end(); }
}

async function isolatedTables(tx: TransactionSql) {
  // Temp tables shadow public ones (pg_temp is searched first), so get_balance
  // and every admin query read only these fixtures.
  for (const table of ['usage_events', 'channels', 'usage_route_snapshots', 'profiles', 'ledger', 'entitlements', 'abuse_strikes']) {
    await tx.unsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`);
  }
  // Only the columns media cost recovery reads.
  await tx.unsafe('CREATE TEMP TABLE media_jobs (request_id text UNIQUE, credit_multiplier numeric(10,2)) ON COMMIT DROP');
}

async function fixtures(tx: TransactionSql) {
  const heavy = randomUUID();
  const light = randomUUID();
  const idle = randomUUID();
  await tx.unsafe(
    "INSERT INTO profiles (id,email,role,status,billing_hold) VALUES " +
    "($1,'heavy@test.local','user','active',false),($2,'light@test.local','user','suspended',true),($3,'idle@test.local','user','active',false)",
    [heavy, light, idle],
  );
  await tx.unsafe(
    "INSERT INTO channels (id,label,task,provider,model_id,public_model_id,input_per_mtok,output_per_mtok,cached_per_mtok) VALUES " +
    "('fast','Fast catalog label','chat.completions','openai_compatible','private','fast-model',1,1,0)",
  );
  const events = [
    ['h1', heavy, 'fast', 'ok', 100, 50, 0, 120, 40, .004, 1],
    ['h2', heavy, 'fast', 'ok', 200, 80, 10, 150, 60, .006, 2],
    ['h3', heavy, 'fast', 'failed', null, null, null, 900, 0, null, 3],
    ['l1', light, 'fast', 'ok', 10, 5, 0, 80, 5, null, 4],
    ['old', heavy, 'fast', 'ok', 1, 1, 0, 10, 1000, .1, 48],
    ['future', light, 'fast', 'ok', 1, 1, 0, 10, 1000, .1, -1],
  ] as const;
  for (const [id, user, channel, status, input, output, cached, latency, credits, cost, hoursAgo] of events) {
    await tx.unsafe(
      'INSERT INTO usage_events (request_id,user_id,channel_id,status,input_tokens,output_tokens,cached_tokens,latency_ms,credits_charged,cost_usd,created_at) ' +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now() - $11 * interval '1 hour')",
      [id, user, channel, status, input, output, cached, latency, credits, cost, hoursAgo],
    );
  }
  await tx.unsafe(
    "INSERT INTO usage_route_snapshots (request_id,model_id,channel_label,source_id,source_label,provider,task) VALUES " +
    "('h1','settled-model','Settled label','s1','Source one','openai_compatible','chat.completions')",
  );
  return { heavy, light, idle };
}

describe.skipIf(!local)('admin user monitoring database', () => {
  it('narrows usage monitoring to one account without changing attribution', async () => transaction(async (tx) => {
    await isolatedTables(tx);
    const { heavy, light, idle } = await fixtures(tx);

    const all = await usageMonitoring('24h', 'requests', tx);
    expect(all.summary).toMatchObject({ requests: 4, consumers: 2, credits: 105 });

    const mine = await usageMonitoring('24h', 'requests', tx, { userId: heavy });
    expect(mine.summary).toMatchObject({
      requests: 3, consumers: 1, successful_requests: 2, errors: 1, credits: 100,
      cost_usd: .01, input_tokens: 300, output_tokens: 130, cached_tokens: 10,
    });
    expect(mine.models.map((row) => [row.model_id, row.requests])).toEqual([
      ['fast-model', 2], ['settled-model', 1],
    ]);
    expect((await usageMonitoring('7d', 'requests', tx, { userId: heavy })).summary.credits).toBe(1100);
    expect((await usageMonitoring('24h', 'requests', tx, { userId: light })).summary.requests).toBe(1);
    const none = await usageMonitoring('30d', 'requests', tx, { userId: idle });
    expect(none.summary.requests).toBe(0);
    expect(none.models).toEqual([]);
  }));

  it('ranks consumers by credits in the window and reads their balance', async () => transaction(async (tx) => {
    await isolatedTables(tx);
    const { heavy, light } = await fixtures(tx);
    await tx.unsafe(
      "INSERT INTO ledger (user_id,request_id,kind,credits) VALUES ($1,'g1','grant',500),($1,'s1','settle',-100),($2,'g2','grant',3)",
      [heavy, light],
    );

    const day = await topConsumers('24h', 10, tx);
    expect(day.map((row) => [row.email, row.credits, row.requests, row.balance])).toEqual([
      ['heavy@test.local', 100, 3, 400],
      ['light@test.local', 5, 1, 3],
    ]);
    // 100 credits at $0.0001 earned $0.01 against $0.01 of provider cost.
    expect(day[0]).toMatchObject({
      errors: 1, tokens: 440, revenue_usd: .01, provider_cost_usd: .01, profit_usd: 0, unpriced_requests: 0,
    });
    // The light user's request has no cost record, so it earns revenue but no profit.
    expect(day[1]).toMatchObject({
      revenue_usd: .0005, provider_cost_usd: 0, profit_usd: 0, unpriced_requests: 1, unpriced_revenue_usd: .0005,
    });
    expect(day[0]!.last_used_at).toBeInstanceOf(Date);
    expect(await topConsumers('24h', 1, tx)).toHaveLength(1);
    // The 48h-old event only counts in the wider window; the future row never does.
    expect((await topConsumers('7d', 10, tx))[0]).toMatchObject({ credits: 1100, requests: 4 });
    expect((await topConsumers('7d', 10, tx))[1]).toMatchObject({ credits: 5 });
  }));

  it('lists the newest requests with settled labels, for everyone or one account', async () => transaction(async (tx) => {
    await isolatedTables(tx);
    const { heavy, idle } = await fixtures(tx);

    const feed = await recentRequests({ limit: 10 }, tx);
    expect(feed.map((row) => row.request_id)).toEqual(['h1', 'h2', 'h3', 'l1', 'old']);
    expect(feed[0]).toMatchObject({
      email: 'heavy@test.local', model_id: 'settled-model', channel_label: 'Settled label',
      source_label: 'Source one', credits_charged: 40, cost_usd: .004, latency_ms: 120,
    });
    expect(feed[1]).toMatchObject({ model_id: 'fast-model', channel_label: 'Fast catalog label', source_label: null });
    expect(feed[2]).toMatchObject({ status: 'failed', input_tokens: null, cost_usd: null });

    expect((await recentRequests({ limit: 2 }, tx)).map((row) => row.request_id)).toEqual(['h1', 'h2']);
    expect((await recentRequests({ userId: heavy, limit: 10 }, tx)).map((row) => row.request_id)).toEqual(['h1', 'h2', 'h3', 'old']);
    expect(await recentRequests({ userId: idle, limit: 10 }, tx)).toEqual([]);
  }));

  it('reports balance, reserved holds and account state for one user', async () => transaction(async (tx) => {
    await isolatedTables(tx);
    const { heavy, light, idle } = await fixtures(tx);
    await tx.unsafe(
      'INSERT INTO ledger (user_id,request_id,kind,credits) VALUES ' +
      "($1,'grant-1','grant',1000)," +
      // Finished request: hold, its release and the actual charge.
      "($1,'r1','hold',-50),($1,'r1:release','release',50),($1,'r1:settle','settle',-30)," +
      // Still in flight: only the hold exists.
      "($1,'r2','hold',-70)",
      [heavy],
    );
    await tx.unsafe(
      "INSERT INTO entitlements (user_id,plan_key,status,monthly_credits,current_period_end) VALUES ($1,'pro','active',20000,now() + interval '10 days')",
      [heavy],
    );
    await tx.unsafe(
      "INSERT INTO abuse_strikes (user_id,request_id,created_at) VALUES ($1,'strike-1',now()),($1,'strike-2',now() - interval '2 days')",
      [light],
    );

    const account = await userAccount(heavy, tx);
    expect(account).toMatchObject({
      email: 'heavy@test.local', status: 'active', billing_hold: false,
      plan_key: 'pro', entitlement_status: 'active', monthly_credits: 20000,
      // 1000 granted - 30 settled - 70 still held; r1's hold and release cancel out.
      balance: 900, reserved: 70, strikes_24h: 0,
    });
    expect(account!.last_used_at).toBeInstanceOf(Date);

    expect(await userAccount(light, tx)).toMatchObject({
      status: 'suspended', billing_hold: true, plan_key: null, monthly_credits: null,
      balance: 0, reserved: 0, strikes_24h: 1,
    });
    expect(await userAccount(idle, tx)).toMatchObject({ balance: 0, reserved: 0, last_used_at: null });
    expect(await userAccount(randomUUID(), tx)).toBeNull();
  }));

  it('shows credit additions and reversals but not per-request ledger rows', async () => transaction(async (tx) => {
    await isolatedTables(tx);
    const { heavy, light } = await fixtures(tx);
    await tx.unsafe(
      'INSERT INTO ledger (user_id,request_id,kind,credits,meta,created_at) VALUES ' +
      "($1,'topup-1','topup',5000,null,now() - interval '3 days')," +
      "($1,'grant-1','grant',250,'{\"reason\":\"support credit\"}',now() - interval '2 days')," +
      "($1,'r1','hold',-50,null,now() - interval '1 day')," +
      "($1,'r1:release','release',50,null,now() - interval '1 day')," +
      "($1,'r1:settle','settle',-30,null,now() - interval '1 day')," +
      "($1,'refund-1','refund',-1000,null,now())," +
      "($2,'grant-other','grant',9,null,now())",
      [heavy, light],
    );

    const history = await userCreditHistory(heavy, 10, tx);
    expect(history.map((row) => [row.kind, row.credits, row.reason])).toEqual([
      ['refund', -1000, null], ['grant', 250, 'support credit'], ['topup', 5000, null],
    ]);
    expect(await userCreditHistory(heavy, 1, tx)).toHaveLength(1);
  }));

  it('values revenue, provider cost and profit, excluding BYOK and recovering media cost', async () => transaction(async (tx) => {
    await isolatedTables(tx);
    await fixtures(tx);
    const econ = randomUUID();
    await tx.unsafe("INSERT INTO profiles (id,email,role,status,billing_hold) VALUES ($1,'econ@test.local','user','active',false)", [econ]);
    await tx.unsafe(
      "INSERT INTO channels (id,label,task,provider,model_id,public_model_id,input_per_mtok,output_per_mtok,cached_per_mtok) VALUES " +
      "('img','Image','image.generate','kie','img','image-model',0,0,0)",
    );
    const rows = [
      // Caller's own key: nothing charged, and the provider bill is theirs.
      ['byok', 'fast', 0, .02, 'BYOK'],
      // Media with the upstream's reported credits: 6 x $0.005 = $0.03 cost.
      ['media-reported', 'img', 450, null, null],
      // Media without a report: 500 credits at 2x markup cost 500 x $0.0001 / 2.
      ['media-markup', 'img', 500, null, null],
      // A 0x platform source: we paid, the caller was charged nothing.
      ['free-source', 'fast', 0, .01, null],
      // No cost and no media job: revenue that cannot be priced.
      ['unpriced', 'img', 200, null, null],
    ] as const;
    for (const [id, channel, credits, cost, label] of rows) {
      await tx.unsafe(
        "INSERT INTO usage_events (request_id,user_id,channel_id,status,credits_charged,cost_usd,source_label,created_at) VALUES ($1,$2,$3,'ok',$4,$5,$6,now() - interval '1 hour')",
        [id, econ, channel, credits, cost, label],
      );
      await tx.unsafe(
        "INSERT INTO usage_route_snapshots (request_id,model_id,channel_label,source_id,source_label,provider,task) VALUES ($1,$2,'label',null,$3,'p','t')",
        [id, channel === 'img' ? 'image-model' : 'fast-model', label],
      );
    }
    await tx.unsafe("INSERT INTO media_jobs (request_id,credit_multiplier) VALUES ('media-reported',1.5),('media-markup',2)");
    await tx.unsafe(
      "INSERT INTO ledger (user_id,request_id,kind,credits,meta) VALUES " +
      `($1,'media-reported:settle','settle',-450,'{"upstream_credits":6}'),` +
      `($1,'media-markup:settle','settle',-500,'{"upstream_credits":null}')`,
      [econ],
    );

    const { summary, models } = await usageMonitoring('24h', 'profit', tx, { userId: econ });
    expect(summary.revenue_usd).toBeCloseTo(.115, 10);
    expect(summary.provider_cost_usd).toBeCloseTo(.065, 10);
    // 0 (BYOK) + .015 + .025 - .01; the unpriced request is left out.
    expect(summary.profit_usd).toBeCloseTo(.03, 10);
    expect(summary).toMatchObject({
      unpriced_requests: 1, estimated_cost_requests: 2, byok_requests: 1, unearned_cost_requests: 1,
    });
    expect(summary.unpriced_revenue_usd).toBeCloseTo(.02, 10);
    expect(summary.unearned_cost_usd).toBeCloseTo(.01, 10);
    // Ranked by profit: images earn, the fast model loses on the 0x source.
    expect(models.map((row) => row.model_id)).toEqual(['image-model', 'fast-model']);
    expect(models[1]!.profit_usd).toBeCloseTo(-.01, 10);

    const recent = new Map((await recentRequests({ userId: econ, limit: 10 }, tx)).map((row) => [row.request_id, row]));
    expect(recent.get('byok')).toMatchObject({ byok: true, provider_cost_usd: 0, revenue_usd: 0, cost_estimated: false });
    expect(recent.get('media-reported')).toMatchObject({ provider_cost_usd: .03, revenue_usd: .045, cost_estimated: true });
    expect(recent.get('media-markup')).toMatchObject({ provider_cost_usd: .025, cost_estimated: true });
    expect(recent.get('unpriced')).toMatchObject({ provider_cost_usd: null, revenue_usd: .02, cost_estimated: false });
  }));

  it('labels BYOK usage in the route snapshot instead of the platform source', async () => transaction(async (tx) => {
    // The source trigger must keep explicit labels, as it does once 000701 is applied.
    for (const file of ['20260921000701_preserve_media_usage_label.sql', '20260924020000_byok_usage_route_label.sql']) {
      await tx.unsafe(await readFile('supabase/migrations/' + file, 'utf8'));
    }
    const user = randomUUID();
    const id = 'byok-route-' + randomUUID();
    await tx.unsafe('INSERT INTO auth.users (id,email) VALUES ($1,$2)', [user, id + '@test.local']);
    await tx.unsafe("INSERT INTO sources (id,family,label,credit_multiplier) VALUES ($1,'gpt','Platform source',1)", [id]);
    await tx.unsafe(
      "INSERT INTO channels (id,label,task,provider,model_id,public_model_id,source_id,input_per_mtok,output_per_mtok,cached_per_mtok) " +
      "VALUES ($1,'Platform channel','chat.completions','openai_compatible','private','public-model',$1,1,1,0)",
      [id],
    );
    await tx.unsafe(
      "INSERT INTO usage_events (request_id,user_id,channel_id,status,credits_charged,cost_usd,source_id,source_label) VALUES ($1,$2,$3,'ok',0,.02,null,'BYOK')",
      [id + '-byok', user, id],
    );
    await tx.unsafe(
      "INSERT INTO usage_events (request_id,user_id,channel_id,status,credits_charged,cost_usd) VALUES ($1,$2,$3,'ok',20,.002)",
      [id + '-platform', user, id],
    );
    const snapshots = await tx.unsafe(
      'SELECT u.request_id, u.source_id AS usage_source, u.source_label AS usage_label, r.source_id, r.source_label, r.model_id ' +
      'FROM usage_events u JOIN usage_route_snapshots r USING (request_id) WHERE u.user_id = $1 ORDER BY u.request_id',
      [user],
    );
    expect(snapshots).toEqual([
      { request_id: id + '-byok', usage_source: null, usage_label: 'BYOK', source_id: null, source_label: 'BYOK', model_id: 'public-model' },
      { request_id: id + '-platform', usage_source: id, usage_label: 'Platform source', source_id: id, source_label: 'Platform source', model_id: 'public-model' },
    ]);
  }), 30000);

  it('replaces the user_id index with a user_id, created_at index', async () => transaction(async (tx) => {
    await tx.unsafe(await readFile('supabase/migrations/20260924010000_usage_events_user_time_index.sql', 'utf8'));
    const indexes = await tx.unsafe(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'usage_events'",
    );
    const names = indexes.map((row) => row.indexname);
    expect(names).toContain('usage_events_user_created_idx');
    expect(names).not.toContain('usage_events_user_id_idx');
    expect(indexes.find((row) => row.indexname === 'usage_events_user_created_idx')?.indexdef)
      .toMatch(/\(user_id, created_at DESC\)/);
    // Re-running is a no-op rather than an error.
    await tx.unsafe(await readFile('supabase/migrations/20260924010000_usage_events_user_time_index.sql', 'utf8'));
  }));
});
