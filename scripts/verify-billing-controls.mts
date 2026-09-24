import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import postgres from 'postgres';
config({path:'.env.local',quiet:true});
if (!['localhost','127.0.0.1','[::1]'].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error('Local database only');
const sql = postgres(process.env.DATABASE_URL!,{max:8});
const users = [randomUUID(),randomUUID(),randomUUID()];
const payments = users.map(()=>'pay_controls_'+randomUUID());
let appSql: {end():Promise<void>} | undefined;
try {
  if (process.argv.includes('--migrate')) {
    for (const [version,name] of [['20260921070000','redemption_codes'],['20260921080000','billing_orders_disputes']] as const) {
      const body = await readFile(`supabase/migrations/${version}_${name}.sql`,'utf8');
      await sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(20260920)`;
        if (!(await tx`SELECT version FROM supabase_migrations.schema_migrations WHERE version=${version}`).length) {
          await tx.unsafe(body);
          await tx`INSERT INTO supabase_migrations.schema_migrations(version,name) VALUES(${version},${name})`;
        }
      });
    }
    console.log('Applied only the two local billing control migrations.');
  }
  const db = await import('../lib/db/index'); appSql=db.sql;
  const {redeemCreditCode,createRedemptionCode} = await import('../lib/billing/redemption');
  const {releaseDisputeHold} = await import('../lib/billing/review');
  const {billingLeaderboard,orderHistory} = await import('../lib/billing/reports');
  for (const user of users) await sql`INSERT INTO auth.users(id,email) VALUES(${user},${'controls-'+user+'@test.local'})`;
  const grant = (payment: string,user: string,reversed=0) => sql`SELECT sync_whop_purchase(${payment},${user},100000,${reversed},'topup',${sql.json({source:'whop',payment_id:payment,amount_cents:1000,total_cents:1000,confirmed_event_type:'payment.succeeded'})})`;
  await Promise.all(Array.from({length:6},()=>grant(payments[0]!,users[0]!)));
  await Promise.all([grant(payments[0]!,users[0]!,50000),grant(payments[0]!,users[0]!,100000),grant(payments[0]!,users[0]!,0)]);
  assert.equal(Number((await sql`SELECT credits_reversed FROM billing_orders WHERE payment_id=${payments[0]!}`)[0]!.credits_reversed),100000);
  assert.equal((await orderHistory({userId:users[1],page:1})).total,0);
  await grant(payments[1]!,users[0]!);
  const leaderboard = await billingLeaderboard('topups',1);
  const ranked = leaderboard.find(row=>row.id===users[0]);
  assert.ok(ranked); assert.equal(Number(ranked.topups),100000); assert.equal(Number(ranked.balance),100000); assert.equal(Number(ranked.orders),2);
  const dispute = (id:string,status:string,updated:string) => sql`SELECT sync_whop_dispute(${id},${payments[0]!},${status},1000,'usd','fraudulent',${updated}::timestamptz,null)`;
  const d1='dspt_'+randomUUID(),d2='dspt_'+randomUUID();
  await dispute(d1,'needs_response','2026-09-21T00:00:00Z');
  const guard=await sql`SELECT guard_admit(${users[0]!},${randomUUID()},null,10,10,2) AS result`;
  assert.equal(guard[0]!.result.allowed,false);
  await dispute(d1,'won','2026-09-21T00:02:00Z');
  await dispute(d1,'needs_response','2026-09-21T00:01:00Z');
  assert.equal((await sql`SELECT status FROM billing_disputes WHERE provider_dispute_id=${d1}`)[0]!.status,'won');
  await dispute(d2,'under_review','2026-09-21T00:00:00Z');
  const localId=(await sql`SELECT id FROM billing_disputes WHERE provider_dispute_id=${d1}`)[0]!.id;
  await releaseDisputeHold(users[2]!,localId,'Won; verified payment case outcome.');
  assert.equal((await sql`SELECT billing_hold FROM profiles WHERE id=${users[0]!}`)[0]!.billing_hold,true);
  await dispute(d2,'closed','2026-09-21T00:02:00Z');
  await sql`UPDATE profiles SET status='suspended' WHERE id=${users[0]!}`;
  await releaseDisputeHold(users[2]!, (await sql`SELECT id FROM billing_disputes WHERE provider_dispute_id=${d2}`)[0]!.id,'Closed; verified case and release.');
  await dispute(d1,'won','2026-09-21T00:02:00Z');
  const profile=(await sql`SELECT status,billing_hold FROM profiles WHERE id=${users[0]!}`)[0]!;
  assert.equal(profile.billing_hold,false); assert.equal(profile.status,'suspended');
  const code=await createRedemptionCode({createdBy:users[2]!,credits:12345,maxRedemptions:1,expiresAt:null,label:'verification'});
  await assert.rejects(()=>redeemCreditCode(users[0]!,code.code));
  const results=await Promise.all(Array.from({length:5},()=>redeemCreditCode(users[1]!,code.code)));
  assert.equal(results.filter(result=>result.status==='redeemed').length,1);
  assert.equal(Number((await sql`SELECT sum(credits) AS credits FROM ledger WHERE user_id=${users[1]!}`)[0]!.credits),12345);
  await assert.rejects(()=>redeemCreditCode(users[2]!,code.code));
  const expired=await createRedemptionCode({createdBy:users[2]!,credits:1,maxRedemptions:1,expiresAt:null,label:'expired verification'});
  await sql`UPDATE credit_redemption_codes SET expires_at=now()-interval '1 minute' WHERE id=${expired.id}`;
  await assert.rejects(()=>redeemCreditCode(users[2]!,expired.code));
  const permissions=await sql`SELECT has_column_privilege('authenticated','profiles','billing_hold','UPDATE') AS editable,
    has_table_privilege('authenticated','billing_orders','SELECT') AS readable`;
  assert.equal(permissions[0]!.editable,false);assert.equal(permissions[0]!.readable,false);
  console.log('PASS: atomic orders/refunds, private history, leaderboard totals, stale disputes, generation freeze, multiple disputes, manual suspension, replay after release, concurrent and expired code redemption, and client permissions.');
} finally {
  await sql`DELETE FROM credit_code_redemptions WHERE user_id IN ${sql(users)}`;
  await sql`DELETE FROM credit_redemption_codes WHERE created_by IN ${sql(users)}`;
  await sql`DELETE FROM billing_disputes WHERE user_id IN ${sql(users)}`;
  await sql`DELETE FROM billing_orders WHERE user_id IN ${sql(users)}`;
  await sql`DELETE FROM admin_audit_log WHERE actor_id IN ${sql(users)}`;
  await sql`DELETE FROM guard_counters WHERE bucket IN ${sql(users.map(user=>'redeem:'+user))}`;
  await sql`DELETE FROM auth.users WHERE id IN ${sql(users)}`;
  await appSql?.end();
  await sql.end();
}
