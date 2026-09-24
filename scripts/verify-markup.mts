/**
 * Proves the 1.5x markup is applied once, end to end, for both billing units.
 *
 * Chat is token-billed: the channel holds kie.ai's own per-token price, and
 * the source multiplier turns that into credits at settlement. Media is
 * request-billed and settles on the upstream's reported `creditsConsumed`, so
 * the check there is against what kie.ai actually charged, not an estimate.
 *
 * Local development only.
 *
 *   npx tsx scripts/verify-markup.mts [baseUrl]
 */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

import { generateApiKey } from '../lib/keys/api-key';

const ORIGIN = process.argv[2] ?? 'http://localhost:3001';
const USD_PER_CREDIT = 0.005;
const OUR_USD_PER_CREDIT = 0.0001;
const MULTIPLIER = 1.5;

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

// A user with no BYOK credential: `getUserCredential` decrypts any stored
// credential before comparing its provider, so one malformed row would fail
// the call for reasons unrelated to pricing.
const [profile] = await sql`
  SELECT p.id FROM profiles p
  WHERE NOT EXISTS (SELECT 1 FROM provider_credentials c WHERE c.owner_id = p.id)
  ORDER BY p.created_at LIMIT 1`;
const userId = (profile as { id: string }).id;

const { key, hash, prefix, lastFour } = generateApiKey();
const [row] = await sql`
  INSERT INTO api_keys (owner_id, name, key_hash, key_prefix, last_four, scopes, rate_limit_rpm)
  VALUES (${userId}, 'verify-markup', ${hash}, ${prefix}, ${lastFour}, ${sql.array(['chat', 'media'])}, 120)
  RETURNING id`;
const apiKeyId = (row as { id: string }).id;
await sql`INSERT INTO ledger (user_id, request_id, kind, credits)
          VALUES (${userId}, ${`markup-${randomUUID()}`}, 'topup', 200000)`;

// ---- chat: token-billed ----------------------------------------------------
// Chosen from what the probe left active rather than hardcoded: kie.ai's chat
// surface is intermittent, and a fixed model turns their outage into a script
// crash that looks like our bug.
const [channel] = await sql`
  SELECT c.public_model_id, c.input_per_mtok, c.output_per_mtok
  FROM channels c JOIN sources s ON s.id = c.source_id
  WHERE c.task='chat.completions' AND c.status='active' AND s.modality='chat'
    AND s.status <> 'off' AND c.provider='openai_compatible'
  ORDER BY c.output_per_mtok LIMIT 1`;
if (channel === undefined) {
  console.log('no active chat channel to test; skipping the chat half');
}
const rates = (channel ?? { input_per_mtok: '0', output_per_mtok: '0' }) as {
  input_per_mtok: string;
  output_per_mtok: string;
};
const MODEL = (channel as { public_model_id?: string } | undefined)?.public_model_id ?? '';
console.log(`chat model ${MODEL}: stored $${rates.input_per_mtok}/$${rates.output_per_mtok} per Mtok`);

const chat = MODEL === '' ? null : await fetch(`${ORIGIN}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    max_tokens: 16,
  }),
});
const chatBody = chat === null ? null : await chat.json();
if (chat !== null) console.log(`POST /v1/chat/completions -> ${chat.status}`, chatBody.usage ?? chatBody);

if (chat !== null && chat.ok) {
  const [event] = await sql`
    SELECT input_tokens, output_tokens, cost_usd, credits_charged FROM usage_events
    WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`;
  const e = event as {
    input_tokens: number;
    output_tokens: number;
    cost_usd: string;
    credits_charged: string;
  };
  const expectedUsd =
    (e.input_tokens * Number(rates.input_per_mtok) +
      e.output_tokens * Number(rates.output_per_mtok)) /
    1_000_000;
  const expectedCredits = Math.ceil(Number(((expectedUsd / OUR_USD_PER_CREDIT) * MULTIPLIER).toFixed(6)));
  console.log(`  upstream cost  $${Number(e.cost_usd).toFixed(8)} (expected $${expectedUsd.toFixed(8)})`);
  console.log(`  credits charged ${e.credits_charged} (expected ${expectedCredits} = cost x ${MULTIPLIER})`);
  console.log(`  markup check   ${Number(e.credits_charged) === expectedCredits ? 'PASS' : 'FAIL'}`);
}

// ---- media: request-billed, settled on actual upstream credits -------------
const IMAGE_MODEL = 'google/imagen4';
const SKIP_MEDIA = process.argv.includes('--chat-only');
const created = await fetch(`${ORIGIN}/v1/images`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model: IMAGE_MODEL,
    input: { prompt: 'a plain grey square', aspect_ratio: '1:1' },
  }),
});
const createdBody = await created.json();
console.log(`\nPOST /v1/images (${IMAGE_MODEL}) -> ${created.status}`, createdBody.id ?? createdBody);

if (created.status === 202 && !SKIP_MEDIA) {
  const secret = process.env.CRON_SECRET!;
  let status = 'running';
  for (let i = 0; i < 40 && status !== 'succeeded' && status !== 'failed'; i += 1) {
    await new Promise((r) => setTimeout(r, 8000));
    await fetch(`${ORIGIN}/api/cron/sweep-media`, { headers: { authorization: `Bearer ${secret}` } });
    const poll = await fetch(`${ORIGIN}/v1/images/${createdBody.id}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    status = (await poll.json()).status;
  }
  const [job] = await sql`
    SELECT credits_held, credits_charged, credit_multiplier, status FROM media_jobs
    WHERE id = ${createdBody.id}`;
  const j = job as {
    credits_held: string;
    credits_charged: string;
    credit_multiplier: string;
    status: string;
  };
  const [settle] = await sql`
    SELECT meta FROM ledger WHERE request_id LIKE (
      SELECT request_id || ':settle' FROM media_jobs WHERE id = ${createdBody.id})`;
  const upstreamCredits = (settle as { meta: { upstream_credits: number | null } } | undefined)?.meta
    .upstream_credits;
  console.log(`  status ${j.status}, held ${j.credits_held}, charged ${j.credits_charged}`);
  if (typeof upstreamCredits === 'number') {
    const expected = Math.ceil(
      Number(((upstreamCredits * USD_PER_CREDIT) / OUR_USD_PER_CREDIT * MULTIPLIER).toFixed(6)),
    );
    console.log(
      `  upstream consumed ${upstreamCredits} kie credits = $${(upstreamCredits * USD_PER_CREDIT).toFixed(4)}`,
    );
    console.log(`  expected charge ${expected} (x${MULTIPLIER}) — actual ${j.credits_charged}`);
    console.log(`  markup check   ${Number(j.credits_charged) === expected ? 'PASS' : 'FAIL'}`);
  }
}

await sql`UPDATE api_keys SET status='revoked', revoked_at=now() WHERE id = ${apiKeyId}`;
await sql.end();
