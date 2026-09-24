import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

config({ path: '.env.local', quiet: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Local verification only');
const origin = process.argv[2] ?? 'http://localhost:3001';
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname)) throw new Error('Local app only');
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const email = 'billing-page-' + randomUUID() + '@test.local';
const password = randomUUID();
const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (created.error || !created.data.user) throw new Error('Cannot create verification user');
const codeId = randomUUID();
const otherCodeId = randomUUID();
try {
  const jar = new Map<string, string>();
  const client = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => { for (const cookie of cookies) jar.set(cookie.name, cookie.value); },
    },
  });
  const login = await client.auth.signInWithPassword({ email, password });
  if (login.error) throw new Error('Cannot authenticate verification user');
  const headers = { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') };
  const page = await fetch(origin + '/dashboard/billing', { headers });
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const text of ['$14.99', '$29.99', '$49.99', '149,000', '299,000', '499,000', '50,000', 'Custom amount (USD)', 'min="1"', 'max="2500"', '/billing-terms']) {
    assert.ok(html.includes(text), `Missing billing content: ${text}`);
  }
  assert.ok(!html.includes('WHOP_API_KEY'));
  assert.ok(html.includes('Redeem credits'));
  const history = await fetch(origin + '/dashboard/billing/history', {headers});
  assert.equal(history.status,200);
  assert.ok((await history.text()).includes('Redemption history'));
  const denied = await fetch(origin + '/admin/orders', {headers,redirect:'manual'});
  assert.ok([303,307].includes(denied.status));
  const deniedCode = await fetch(origin + '/admin/redemption-codes/' + codeId, {headers,redirect:'manual'});
  assert.ok([303,307].includes(deniedCode.status));
  const promoted = await admin.from('profiles').update({role:'admin'}).eq('id',created.data.user.id);
  if (promoted.error) throw new Error('Cannot promote local test user');
  const codes = await admin.from('credit_redemption_codes').insert([
    {id:codeId,code_hash:randomUUID(),code_prefix:'TEST-CODE',credits:12345,redemption_count:1,created_by:created.data.user.id},
    {id:otherCodeId,code_hash:randomUUID(),code_prefix:'OTHER-CODE',credits:98765,redemption_count:1,created_by:created.data.user.id},
  ]);
  if (codes.error) throw codes.error;
  const redemptions = await admin.from('credit_code_redemptions').insert([
    {code_id:codeId,user_id:created.data.user.id,request_id:randomUUID(),credits:12345,redeemed_at:'2026-09-21T01:02:03Z'},
    {code_id:otherCodeId,user_id:created.data.user.id,request_id:randomUUID(),credits:98765,redeemed_at:'2026-09-21T02:03:04Z'},
  ]);
  if (redemptions.error) throw redemptions.error;
  const codeHistory = await fetch(origin + '/admin/redemption-codes/' + codeId, {headers});
  assert.equal(codeHistory.status,200);
  const codeHtml = await codeHistory.text();
  for (const value of [email,created.data.user.id,'12,345','2026-09-21 01:02:03','Customer orders']) assert.ok(codeHtml.includes(value),value);
  assert.ok(!codeHtml.includes('98,765'),'Another code must not leak into this history');
  const invalidCode = await fetch(origin + '/admin/redemption-codes/not-a-uuid',{headers});
  assert.equal(invalidCode.status,404);
  for (const [path,title] of [['orders','Orders'],['disputes','Disputes and account freezes'],['leaderboard','Credit leaderboard'],['redemption-codes','Redemption codes']]) {
    const response = await fetch(origin + '/admin/' + path,{headers});
    assert.equal(response.status,200,path);
    assert.ok((await response.text()).includes(title!),path);
  }
  const frozen = await admin.from('profiles').update({billing_hold:true}).eq('id',created.data.user.id);
  if (frozen.error) throw new Error('Cannot freeze local test user');
  const frozenPage = await fetch(origin + '/dashboard/billing',{headers});
  assert.ok((await frozenPage.text()).includes('Your account is frozen'));
  const status = await fetch(origin + '/api/billing/status?purchase=' + randomUUID(), { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).purchase_confirmed, false);
  const confirmedId = randomUUID();
  const fixture = await admin.from('ledger').insert({ user_id: created.data.user.id, request_id: 'whop-page-test-' + confirmedId, kind: 'topup', credits: 50000, meta: { source: 'whop', purchase_id: confirmedId } });
  if (fixture.error) throw new Error('Cannot create local purchase fixture');
  const confirmed = await fetch(origin + '/api/billing/status?purchase=' + confirmedId, { headers });
  assert.equal((await confirmed.json()).purchase_confirmed, true);
  const anonymous = await fetch(origin + '/api/billing/status?purchase=' + confirmedId);
  assert.equal(anonymous.status, 401);
  const terms = await fetch(origin + '/billing-terms');
  assert.equal(terms.status, 200);
  assert.ok((await terms.text()).includes('Refund eligibility'));
  console.log('PASS: billing pages, admin access controls, per-code redeemer identity/credits/time, code isolation, invalid code IDs, freeze banner, and account-scoped purchase status.');
} finally {
  const removedRedemptions = await admin.from('credit_code_redemptions').delete().in('code_id',[codeId,otherCodeId]);
  if (removedRedemptions.error) throw removedRedemptions.error;
  const removedCodes = await admin.from('credit_redemption_codes').delete().in('id',[codeId,otherCodeId]);
  if (removedCodes.error) throw removedCodes.error;
  const result = await admin.auth.admin.deleteUser(created.data.user.id);
  if (result.error) throw new Error('Could not remove local verification user');
}
