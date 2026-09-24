/** Runs only against local Supabase and its captured email inbox. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { sendSignupCode, verifySignupCode } from '../lib/auth/signup';

config({ path: '.env.local', quiet: true });
const base = process.env.NEXT_PUBLIC_SUPABASE_URL!;
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'This check only runs locally.');
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const admin = createClient(base, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const client = createClient(base, anon, { auth: { persistSession: false, autoRefreshToken: false, flowType: 'pkce' } });
const email = `signup-check-${randomUUID()}@example.test`;
const details = { username: 'signup_check', email, password: 'Local-check-482!', confirmPassword: 'Local-check-482!' };
let userId: string | undefined;
let messageId: string | undefined;

try {
  const settings = await (await fetch(`${base}/auth/v1/settings`, { headers: { apikey: anon } })).json();
  assert.equal(settings.mailer_autoconfirm, false, 'Email confirmation must be enabled.');
  await sendSignupCode(client.auth, details);
  assert.equal((await client.auth.getSession()).data.session, null);

  const unconfirmed = await client.auth.signInWithPassword({ email, password: details.password });
  assert.equal(unconfirmed.error?.code, 'email_not_confirmed');
  assert.equal(unconfirmed.data.session, null);

  const search = await (await fetch(`http://127.0.0.1:54324/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json();
  const message = search.messages?.find((item: { To: { Address: string }[] }) => item.To.some((recipient) => recipient.Address === email));
  assert(message, 'Signup email was not delivered to the local inbox.');
  messageId = message.ID;
  const delivered = await (await fetch(`http://127.0.0.1:54324/api/v1/message/${messageId}`)).json();
  assert.equal(delivered.Subject, 'Your sitegen verification code');
  const code = String(delivered.Text).match(/\b\d{6}\b/)?.[0];
  assert(code, 'Email must contain a six-digit code.');

  await assert.rejects(verifySignupCode(client.auth, email, code === '000000' ? '000001' : '000000'));
  assert.equal((await client.auth.getSession()).data.session, null);
  await assert.rejects(sendSignupCode(client.auth, details, true), (error: unknown) =>
    Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'over_email_send_rate_limit'));

  await verifySignupCode(client.auth, email, code);
  const { data: { user } } = await client.auth.getUser();
  userId = user?.id;
  assert(user?.email_confirmed_at);
  assert.equal(user?.user_metadata.username, details.username);
  assert.equal(user?.email, email);
  await client.auth.signOut();
  await assert.rejects(verifySignupCode(client.auth, email, code));
  assert.equal((await client.auth.getSession()).data.session, null);

  const signedIn = await client.auth.signInWithPassword({ email, password: details.password });
  assert.equal(signedIn.error, null);
  assert(signedIn.data.session);
  await client.auth.signOut();
  console.log('PASS: code email delivered; unconfirmed login, incorrect code, rapid resend and code reuse blocked; verified signup, username persistence and password login succeeded.');
} finally {
  if (!userId) {
    // Locate only this run's unique test account if an earlier assertion failed.
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    userId = data.users.find((user) => user.email === email)?.id;
  }
  if (userId) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw error;
  }
  if (messageId) await fetch(`http://127.0.0.1:54324/api/v1/messages`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: [messageId] }),
  });
}
