import { randomUUID } from 'node:crypto';
import postgres, { type Row, type TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const local = databaseUrl && ['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname);

/** Runs against the real functions and tables, then rolls everything back. */
async function transaction(check: (tx: TransactionSql) => Promise<void>) {
  const client = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
  const rollback = new Error('rollback referral fixtures');
  try {
    await expect(client.begin(async (tx) => {
      await tx`UPDATE referral_settings SET enabled = true, commission_bps = 300, bonus_bps = 500, hold_days = 7, window_days = 365`;
      await check(tx);
      throw rollback;
    })).rejects.toBe(rollback);
  } finally { await client.end(); }
}

/** auth.users rows; the signup trigger creates the matching profiles. */
async function signup(tx: TransactionSql, id: string, name: string) {
  await tx`INSERT INTO auth.users (id, email) VALUES (${id}, ${`${name}-${id}@test.local`})`;
}

/** The first row a query returns; fails the test when there is none. */
async function one(query: PromiseLike<readonly Row[]>): Promise<Row> {
  const [row] = await query;
  if (row === undefined) throw new Error('expected a row');
  return row;
}

async function users(tx: TransactionSql) {
  const referrer = randomUUID();
  const referred = randomUUID();
  await signup(tx, referrer, 'referrer');
  await signup(tx, referred, 'referred');
  const { code } = await one(tx`SELECT public.ensure_referral_account(${referrer}::uuid) AS code`);
  return { referrer, referred, code: code as string };
}

/** $10 top-up of 100,000 credits, with `reversed` credits refunded. */
async function topup(tx: TransactionSql, userId: string, paymentId: string, reversed = 0, event = 'payment.succeeded') {
  const meta = { source: 'whop', payment_id: paymentId, total_cents: 1000, amount_cents: 1000, confirmed_event_type: event };
  await tx`SELECT public.sync_whop_purchase(${paymentId}, ${userId}::uuid, 100000, ${reversed}, 'topup', ${tx.json(meta)})`;
}

const wallet = async (tx: TransactionSql, userId: string) =>
  (await one(tx`SELECT public.referral_wallet(${userId}::uuid) AS w`)).w as Record<string, number>;
const balance = async (tx: TransactionSql, userId: string) =>
  Number((await one(tx`SELECT credits FROM profiles WHERE id = ${userId}`)).credits);

describe.skipIf(!local)('referral program database', () => {
  it('attributes a fresh signup once and refuses abuse', async () => transaction(async (tx) => {
    const { referrer, referred, code } = await users(tx);
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    const claim = async (user: string, value: string) => (await one(tx`SELECT public.claim_referral(${user}::uuid, ${value}) AS r`)).r;
    expect(await claim(referrer, code)).toBe('self_referral');
    expect(await claim(referred, 'NOPE1234')).toBe('invalid_code');
    expect(await claim(referred, code.toLowerCase())).toBe('ok');
    expect(await claim(referred, code)).toBe('already_referred');

    const late = randomUUID();
    await signup(tx, late, 'late');
    await tx`UPDATE profiles SET created_at = now() - interval '3 days' WHERE id = ${late}`;
    expect(await claim(late, code)).toBe('too_late');
  }));

  it('rewards the referrer after the hold and gives the new user a first top-up bonus', async () => transaction(async (tx) => {
    const { referrer, referred, code } = await users(tx);
    await tx`SELECT public.claim_referral(${referred}::uuid, ${code})`;

    // A refund delivery that arrives before payment.succeeded grants nothing.
    await topup(tx, referred, 'pay_ref_early', 0, 'refund.created');
    expect(await tx`SELECT 1 FROM referral_commissions WHERE payment_id = 'pay_ref_early'`).toHaveLength(0);

    await topup(tx, referred, 'pay_ref_1');
    const [reward] = await tx`SELECT full_credits, credits, rate_bps, available_at > now() + interval '6 days' AS held FROM referral_commissions WHERE payment_id = 'pay_ref_1'`;
    expect(reward).toMatchObject({ full_credits: '3000', credits: '3000', rate_bps: 300, held: true });
    expect(await balance(tx, referred)).toBe(105_000);
    expect(await wallet(tx, referrer)).toMatchObject({ pending: 3000, available: 0, total_earned: 3000, invites: 1 });

    // Redelivery does not pay twice; only the first top-up carries a bonus.
    await topup(tx, referred, 'pay_ref_1');
    await topup(tx, referred, 'pay_ref_2');
    expect(await balance(tx, referred)).toBe(205_000);
    expect(await wallet(tx, referrer)).toMatchObject({ pending: 6000, total_earned: 6000 });

    expect(Number((await one(tx`SELECT public.transfer_referral_rewards(${referrer}::uuid) AS n`)).n)).toBe(0);
    await tx`UPDATE referral_commissions SET available_at = now() - interval '1 minute' WHERE payment_id = 'pay_ref_1'`;
    expect(Number((await one(tx`SELECT public.transfer_referral_rewards(${referrer}::uuid) AS n`)).n)).toBe(3000);
    expect(await balance(tx, referrer)).toBe(3000);
    expect(await wallet(tx, referrer)).toMatchObject({ pending: 3000, available: 0, transferred: 3000, reclaimable: 3000 });
  }));

  it('follows refunds and disputes on the paying order', async () => transaction(async (tx) => {
    const { referrer, referred, code } = await users(tx);
    await tx`SELECT public.claim_referral(${referred}::uuid, ${code})`;
    await topup(tx, referred, 'pay_ref_1');
    await tx`UPDATE referral_commissions SET available_at = now() - interval '1 minute'`;
    await tx`SELECT public.transfer_referral_rewards(${referrer}::uuid)`;

    // Half refunded after the reward was already transferred: the wallet owes the difference.
    await topup(tx, referred, 'pay_ref_1', 50_000);
    expect((await one(tx`SELECT credits FROM referral_commissions WHERE payment_id = 'pay_ref_1'`)).credits).toBe('1500');
    expect(await wallet(tx, referrer)).toMatchObject({ available: -1500 });
    expect(await balance(tx, referred)).toBe(52_500);

    await tx`UPDATE billing_orders SET dispute_status = 'needs_response' WHERE payment_id = 'pay_ref_1'`;
    expect((await one(tx`SELECT credits FROM referral_commissions WHERE payment_id = 'pay_ref_1'`)).credits).toBe('0');
    await tx`UPDATE billing_orders SET dispute_status = 'won' WHERE payment_id = 'pay_ref_1'`;
    expect((await one(tx`SELECT credits FROM referral_commissions WHERE payment_id = 'pay_ref_1'`)).credits).toBe('1500');
  }));

  it('records admin cash payouts within what the referrer earned', async () => transaction(async (tx) => {
    const { referrer, referred, code } = await users(tx);
    const admin = randomUUID();
    await signup(tx, admin, 'admin');
    await tx`SELECT public.claim_referral(${referred}::uuid, ${code})`;
    await topup(tx, referred, 'pay_ref_1');
    await topup(tx, referred, 'pay_ref_2');
    await tx`UPDATE referral_commissions SET available_at = now() - interval '1 minute'`;
    const payout = (credits: number, source: string) => tx.savepoint((sp) =>
      sp`SELECT public.record_referral_cash_payout(${referrer}::uuid, ${credits}, ${source}, 60, 'usd', 'PayPal', 'TX-1', null, ${admin}::uuid)`);

    await expect(payout(6001, 'wallet')).rejects.toThrow(/exceeds the available rewards/);
    await payout(2000, 'wallet');
    expect(await wallet(tx, referrer)).toMatchObject({ available: 4000, paid_out: 2000 });

    await expect(payout(1, 'balance')).rejects.toThrow(/transferred to the balance/);
    await tx`SELECT public.transfer_referral_rewards(${referrer}::uuid)`;
    expect(await balance(tx, referrer)).toBe(4000);
    await payout(1500, 'balance');
    expect(await balance(tx, referrer)).toBe(2500);
    expect(await wallet(tx, referrer)).toMatchObject({ available: 0, transferred: 4000, reclaimable: 2500, paid_out: 3500 });
  }));
});
