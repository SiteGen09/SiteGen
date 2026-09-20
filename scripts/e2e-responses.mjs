// Temporary end-to-end proof for POST /v1/responses. Not part of the suite.
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';

const BASE = process.env.GATEWAY_BASE ?? 'http://127.0.0.1:3000';
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62(bytes) {
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (value > 0n) {
    out = ALPHABET.charAt(Number(value % 62n)) + out;
    value /= 62n;
  }
  return out.padStart(43, '0');
}

const sql = postgres('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
const fail = [];
const ok = [];
function check(name, cond, detail = '') {
  (cond ? ok : fail).push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const key = `sk_live_${base62(randomBytes(32))}`;
const hash = createHash('sha256').update(key, 'utf8').digest('hex');
let apiKeyId;

try {
  // A profile with no BYOK credential, so the channel's platform key is used.
  const [profile] = await sql`
    select p.id from profiles p
    where p.status = 'active'
      and not exists (select 1 from provider_credentials c where c.owner_id = p.id)
    limit 1
  `;
  const ownerId = profile.id;
  await sql`
    insert into entitlements (user_id, plan_key, status, monthly_credits)
    values (${ownerId}, 'pro', 'active', 1000000)
    on conflict (user_id) do update set plan_key = 'pro', status = 'active', monthly_credits = 1000000
  `;
  const [row] = await sql`
    insert into api_keys (owner_id, name, key_hash, key_prefix, last_four, scopes, rate_limit_rpm)
    values (${ownerId}, 'e2e-responses', ${hash}, ${key.slice(0, 8)}, ${key.slice(-4)}, ${sql.array(['generate', 'chat'])}, 600)
    returning id
  `;
  apiKeyId = row.id;
  await sql`
    insert into ledger (user_id, request_id, kind, credits)
    values (${ownerId}, ${`e2e-grant-${apiKeyId}`}, 'grant', 5000000)
  `;
  console.log(`fixture: owner=${ownerId} apiKey=${apiKeyId}\n`);

  const H = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const post = (path, body) =>
    fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

  // ---- 1. /v1/responses non-streaming
  let res = await post('/v1/responses', {
    model: 'stub-chat',
    instructions: 'You are terse.',
    input: 'Say hello.',
  });
  const nonStream = await res.json();
  const nsRequestId = nonStream.id?.replace(/^resp_/, '');
  check('responses non-stream 200', res.status === 200, `status=${res.status}`);
  check('object is "response"', nonStream.object === 'response', `object=${nonStream.object}`);
  check('status completed', nonStream.status === 'completed', `status=${nonStream.status}`);
  check('echoes PUBLIC model', nonStream.model === 'stub-chat', `model=${nonStream.model}`);
  check(
    'no upstream id anywhere in body',
    !JSON.stringify(nonStream).includes('stub-fixture'),
  );
  const item = nonStream.output?.[0];
  check('output[0] is message', item?.type === 'message', `type=${item?.type}`);
  check('content part is output_text', item?.content?.[0]?.type === 'output_text');
  check(
    'output_text non-empty',
    typeof item?.content?.[0]?.text === 'string' && item.content[0].text.length > 0,
  );
  check('usage present', typeof nonStream.usage?.total_tokens === 'number');

  // ---- 2. /v1/responses streaming: named SSE events
  res = await post('/v1/responses', { model: 'stub-chat', input: 'Stream please.', stream: true });
  check('responses stream 200', res.status === 200, `status=${res.status}`);
  check(
    'SSE content-type',
    (res.headers.get('content-type') ?? '').includes('text/event-stream'),
    res.headers.get('content-type') ?? '',
  );
  const raw = await res.text();
  const frames = raw
    .split('\n\n')
    .filter((f) => f.trim() !== '')
    .map((f) => {
      const ev = /^event: (.+)$/m.exec(f);
      const data = /^data: ([\s\S]+)$/m.exec(f);
      return { event: ev?.[1], data: data?.[1] };
    });
  const streamRequestId = frames
    .map((f) => JSON.parse(f.data ?? '{}').response?.id)
    .find((id) => typeof id === 'string')
    ?.replace(/^resp_/, '');
  check('every frame has event: AND data:', frames.every((f) => f.event && f.data));
  const names = frames.map((f) => f.event);
  check('first event is response.created', names[0] === 'response.created', `first=${names[0]}`);
  check('has response.output_text.delta', names.includes('response.output_text.delta'));
  check('last event is response.completed', names.at(-1) === 'response.completed', `last=${names.at(-1)}`);
  check('no chat.completion.chunk frames', !raw.includes('chat.completion.chunk'));
  check('no [DONE] sentinel', !raw.includes('[DONE]'));
  check('stream never leaks upstream id', !raw.includes('stub-fixture'));
  const deltaText = frames
    .filter((f) => f.event === 'response.output_text.delta')
    .map((f) => JSON.parse(f.data).delta)
    .join('');
  const completed = JSON.parse(frames.at(-1).data);
  check('completed echoes public model', completed.response?.model === 'stub-chat');
  check(
    'deltas reassemble into completed text',
    completed.response?.output?.[0]?.content?.[0]?.text === deltaText,
    `deltas=${JSON.stringify(deltaText)}`,
  );

  // ---- 3. same channel serves /v1/chat/completions, no config duplication
  res = await post('/v1/chat/completions', {
    model: 'stub-chat',
    messages: [{ role: 'user', content: 'Say hello.' }],
  });
  const chat = await res.json();
  const chatRequestId = chat.id?.replace(/^chatcmpl-/, '');
  check('chat completions still 200', res.status === 200, `status=${res.status}`);
  check('chat echoes public model', chat.model === 'stub-chat', `model=${chat.model}`);

  const channels = await sql`select id, task, public_model_id from channels where public_model_id = 'stub-chat'`;
  check(
    'exactly ONE channel row serves both endpoints',
    channels.length === 1,
    `rows=${JSON.stringify(channels)}`,
  );
  const ledgerChannels = await sql`
    select distinct channel_id from ledger
    where request_id like ${`${nsRequestId}%`} or request_id like ${`${chatRequestId}%`}
  `;
  check(
    'both endpoints billed the SAME channel id',
    ledgerChannels.length === 1 && ledgerChannels[0].channel_id === 'chat-stub',
    JSON.stringify(ledgerChannels),
  );

  // ---- 4. refusals are JSON, pre-200, never SSE
  res = await post('/v1/responses', { model: 'no-such-model', input: 'hi', stream: true });
  const unknown = await res.json().catch(() => null);
  check('unknown model refused', res.status >= 400, `status=${res.status}`);
  check(
    'refusal is JSON not SSE',
    !(res.headers.get('content-type') ?? '').includes('text/event-stream'),
    res.headers.get('content-type') ?? '',
  );
  check('refusal has error object', typeof unknown?.error?.message === 'string');

  res = await post('/v1/responses', {
    model: 'stub-chat',
    input: 'hi',
    max_output_tokens: 99999999,
    stream: true,
  });
  check('plan ceiling refused pre-200', res.status >= 400, `status=${res.status}`);
  check(
    'ceiling refusal is JSON not SSE',
    !(res.headers.get('content-type') ?? '').includes('text/event-stream'),
  );
  await res.body?.cancel();

  // ---- 5. ledger settles: hold / :release / :settle on BOTH endpoints
  for (const [label, rid] of [
    ['responses non-stream', nsRequestId],
    ['responses stream', streamRequestId],
    ['chat completions', chatRequestId],
  ]) {
    const rows = await sql`
      select request_id, kind, credits, channel_id from ledger
      where request_id in (${rid}, ${`${rid}:release`}, ${`${rid}:settle`})
      order by request_id
    `;
    const kinds = rows.map((r) => r.kind).sort();
    check(
      `${label}: hold + release + settle present`,
      rows.length === 3 && kinds.join(',') === 'hold,release,settle',
      `rows=${JSON.stringify(rows.map((r) => `${r.request_id}=${r.kind}:${r.credits}`))}`,
    );
  }
} catch (err) {
  console.error('\nSCRIPT ERROR', err);
  fail.push(`script error: ${err.message}`);
} finally {
  if (apiKeyId !== undefined) {
    await sql`update api_keys set status = 'revoked', revoked_at = now() where id = ${apiKeyId}`;
    console.log(`\nrevoked api key ${apiKeyId}`);
  }
  await sql.end();
}

console.log(`\n${ok.length} passed, ${fail.length} failed`);
if (fail.length > 0) {
  console.log(fail.map((f) => `  FAIL ${f}`).join('\n'));
  process.exit(1);
}
