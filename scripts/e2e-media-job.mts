/**
 * End-to-end proof of the image job path against a running local server and
 * the real upstream.
 *
 * Mints a throwaway key for an existing local profile, tops it up, posts a
 * job, drives the polling sweep (the callback cannot reach localhost), then
 * checks the ledger and the stored object. Local development only.
 *
 *   npx tsx scripts/e2e-image-job.mts [baseUrl]
 */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { generateApiKey } from '../lib/keys/api-key';

const ORIGIN = process.argv[2] ?? 'http://localhost:3001';
const KIND = (process.argv[3] ?? 'image') as 'image' | 'video';
const MODEL = process.argv[4] ?? (KIND === 'image' ? 'gpt-image-2-5-flare' : 'gemini-omni-flash-video');
const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

function log(step: string, detail: unknown = '') {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${step}`, detail);
}

const [profile] = await sql`SELECT id FROM profiles ORDER BY created_at LIMIT 1`;
if (profile === undefined) throw new Error('no local profile to test with');
const userId = profile.id as string;

const { key, hash, prefix, lastFour } = generateApiKey();
const [apiKeyRow] = await sql`
  INSERT INTO api_keys (owner_id, name, key_hash, key_prefix, last_four, scopes, rate_limit_rpm)
  VALUES (${userId}, ${'e2e-media'}, ${hash}, ${prefix}, ${lastFour}, ${sql.array(['media'])}, 120)
  RETURNING id`;
if (apiKeyRow === undefined) throw new Error('could not mint a test key');
const apiKeyId = apiKeyRow.id as string;
log('minted key', { apiKeyId, scopes: ['media'] });

await sql`
  INSERT INTO ledger (user_id, request_id, kind, credits)
  VALUES (${userId}, ${`e2e-topup-${randomUUID()}`}, 'topup', 100000)`;
const [before] = await sql`SELECT get_balance(${userId}) AS balance`;
log('balance before', before?.balance);

const created = await fetch(`${ORIGIN}/v1/${KIND}s`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    input:
      KIND === 'image'
        ? { prompt: 'a single teal triangle on white, flat vector', aspect_ratio: '1:1', resolution: '1K' }
        : { prompt: 'a slow push-in on an empty neon-lit street at night', duration: '4' },
  }),
});
const createdBody = await created.json();
log(`POST /v1/${KIND}s -> ${created.status}`, createdBody);
if (created.status !== 202) throw new Error('create failed');

const jobId = createdBody.id as string;
const [held] = await sql`SELECT get_balance(${userId}) AS balance`;
log('balance after hold', held?.balance);

const secret = process.env.CRON_SECRET!;
let status = 'running';
for (let i = 1; i <= 60 && status !== 'succeeded' && status !== 'failed'; i += 1) {
  await new Promise((r) => setTimeout(r, 8000));
  const sweep = await fetch(`${ORIGIN}/api/cron/sweep-media`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  const poll = await fetch(`${ORIGIN}/v1/${KIND}s/${jobId}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const body = await poll.json();
  status = body.status;
  log(`poll ${i}`, { sweep: sweep.status, status, url: body.url ? 'signed URL present' : null });
  if (status === 'succeeded') {
    const head = await fetch(body.url, { method: 'HEAD' });
    log(`stored ${KIND}`, {
      http: head.status,
      type: head.headers.get('content-type'),
      bytes: head.headers.get('content-length'),
    });
    log('credits_charged', body.credits_charged);
  }
  if (status === 'failed') log('error', body.error);
}

const [after] = await sql`SELECT get_balance(${userId}) AS balance`;
// `settle_credits` writes its rows under `<request_id>:release` and
// `<request_id>:settle`, so an equality match would show only the hold and
// make a correct settlement look like a missing one.
const entries = await sql`
  SELECT request_id, kind, credits FROM ledger WHERE request_id LIKE (
    SELECT request_id || '%' FROM media_jobs WHERE id = ${jobId}
  ) ORDER BY id`;
log('balance after settle', after?.balance);
log('ledger entries', entries);

await sql`UPDATE api_keys SET status = 'revoked', revoked_at = now() WHERE id = ${apiKeyId}`;
log('revoked test key');
await sql.end();
