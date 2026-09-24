import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

config({ path: '.env.local', quiet: true });
const databaseUrl = process.env.DATABASE_URL!;
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('This verification script only runs against a local database.');
}
const sql = postgres(databaseUrl, { max: 8 });
const version = '20260921063000';
try {
  if (process.argv.includes('--migrate')) {
    const migration = await readFile(`supabase/migrations/${version}_whop_purchases.sql`, 'utf8');
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(20260920)`;
      const applied = await tx`SELECT version FROM supabase_migrations.schema_migrations WHERE version = ${version}`;
      if (!applied.length) {
        await tx.unsafe(migration);
        await tx`INSERT INTO supabase_migrations.schema_migrations(version, name) VALUES (${version}, 'whop_purchases')`;
      }
    });
    console.log('Whop migration applied to local database.');
  }
  const userId = randomUUID();
  const paymentId = 'pay_local_test_' + randomUUID();
  // The fixture is isolated to a new local auth user and removed in finally.
  await sql`INSERT INTO auth.users(id, email) VALUES (${userId}, ${'whop-test-' + userId + '@test.local'})`;
  try {
    const meta = { source: 'whop', payment_id: paymentId, amount_cents: 52500, total_cents: 52500, confirmed_event_type: 'payment.succeeded' };
    const grant = (reversed: number) => sql`SELECT public.sync_whop_purchase(${paymentId}, ${userId}, 5250000, ${reversed}, 'topup', ${sql.json(meta)}) AS delta`;
    const deliveries = await Promise.all(Array.from({ length: 8 }, () => grant(0)));
    assert.equal(deliveries.reduce((sum, rows) => sum + Number(rows[0]!.delta), 0), 5250000);
    await Promise.all([grant(2625000), grant(5250000), grant(2625000), grant(0)]);
    const rows = await sql`SELECT sum(credits)::text AS balance, count(*)::int AS entries FROM ledger WHERE user_id = ${userId}`;
    assert.equal(rows[0]!.balance, '0');
    await assert.rejects(() => sql`SELECT public.sync_whop_purchase(${paymentId}, ${userId}, 100, 0, 'topup', ${sql.json(meta)})`);
    const permissions = await sql`SELECT has_function_privilege('authenticated', 'public.sync_whop_purchase(text,uuid,bigint,bigint,text,jsonb)', 'EXECUTE') AS allowed`;
    assert.equal(permissions[0]!.allowed, false);
    console.log('PASS: concurrent deliveries grant once; full/partial/out-of-order refunds converge to zero; mismatched grants and client execution are rejected.');
  } finally {
    await sql`DELETE FROM auth.users WHERE id = ${userId}`;
  }
} finally {
  await sql.end();
}
