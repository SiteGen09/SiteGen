import { randomUUID } from 'node:crypto';
import postgres, { type Row, type TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const local = databaseUrl && ['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname);

/** Runs against the real trigger and functions, then rolls everything back. */
async function transaction(check: (tx: TransactionSql) => Promise<void>) {
  const client = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
  const rollback = new Error('rollback username fixtures');
  try {
    await expect(client.begin(async (tx) => {
      await check(tx);
      throw rollback;
    })).rejects.toBe(rollback);
  } finally { await client.end(); }
}

async function one(query: PromiseLike<readonly Row[]>): Promise<Row> {
  const [row] = await query;
  if (row === undefined) throw new Error('expected a row');
  return row;
}

/** An auth.users row as email signup creates it; the trigger makes the profile. */
async function signup(tx: TransactionSql, username: string | null, password: string | null = 'right-password') {
  const id = randomUUID();
  const email = `user-${id}@test.local`;
  await tx`INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data)
    VALUES (${id}, ${email}, ${password === null ? '' : tx`extensions.crypt(${password}, extensions.gen_salt('bf'))`},
      ${tx.json(username === null ? {} : { username })})`;
  return { id, email };
}

const login = (tx: TransactionSql, username: string, password: string, ip = '203.0.113.1') =>
  one(tx`SELECT public.username_login_email(${username}, ${password}, ${ip}) AS r`).then((row) => row.r as { status: string; email?: string });

describe.skipIf(!local)('username login database', () => {
  it('stores signup usernames uniquely regardless of case', async () => transaction(async (tx) => {
    const name = 'Tester_' + randomUUID().slice(0, 8);
    const first = await signup(tx, name);
    expect((await one(tx`SELECT username FROM profiles WHERE id = ${first.id}`)).username).toBe(name);
    expect((await one(tx`SELECT public.username_available(${name.toLowerCase()}) AS a`)).a).toBe(false);
    expect((await one(tx`SELECT public.username_available('free_' || ${randomUUID().slice(0, 8)}) AS a`)).a).toBe(true);

    // A clash the signup form missed still creates the account, just without the username.
    const second = await signup(tx, name.toUpperCase());
    expect((await one(tx`SELECT username FROM profiles WHERE id = ${second.id}`)).username).toBeNull();
    expect(await tx`SELECT 1 FROM entitlements WHERE user_id = ${second.id}`).toHaveLength(1);
  }));

  it('returns the email only for the right password', async () => transaction(async (tx) => {
    const name = 'login_' + randomUUID().slice(0, 8);
    const { email } = await signup(tx, name);
    expect(await login(tx, name.toUpperCase(), 'right-password')).toEqual({ status: 'ok', email });
    expect(await login(tx, name, 'wrong-password')).toEqual({ status: 'invalid' });
    expect(await login(tx, 'nobody_' + randomUUID().slice(0, 8), 'right-password')).toEqual({ status: 'invalid' });

    const google = 'google_' + randomUUID().slice(0, 8);
    await signup(tx, google, null);
    expect(await login(tx, google, '')).toEqual({ status: 'invalid' });
  }));

  it('rate limits guessing per username and per address', async () => transaction(async (tx) => {
    const name = 'limit_' + randomUUID().slice(0, 8);
    await signup(tx, name);
    for (let i = 0; i < 5; i++) await login(tx, name, 'guess-' + i, '203.0.113.' + (10 + i));
    expect(await login(tx, name, 'right-password', '203.0.113.99')).toEqual({ status: 'rate_limited' });

    const ip = '198.51.100.' + Math.floor(Math.random() * 200);
    for (let i = 0; i < 10; i++) await login(tx, 'spray_' + i + '_' + randomUUID().slice(0, 4), 'x', ip);
    expect(await login(tx, 'spray_last', 'x', ip)).toEqual({ status: 'rate_limited' });
  }), 30_000);
});
