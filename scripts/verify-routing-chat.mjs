// Local-only integration proof. A dedicated user and source fixtures prevent
// test traffic from changing an existing developer's preferences or balance.
import { createHash, randomBytes, randomUUID, createCipheriv } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import postgres from 'postgres';
import assert from 'node:assert/strict';

const base = process.env.GATEWAY_BASE ?? 'http://localhost:3001';
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !['localhost', '127.0.0.1'].includes(new URL(base).hostname)
)
  throw new Error('Local verification only');
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const db = postgres('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
const email = 'routing-chat-proof@test.local';
const password = process.env.PROOF_PASSWORD ?? 'Local-proof-' + randomUUID();
const listed = await admin.auth.admin.listUsers();
let user = listed.data.users.find((u) => u.email === email);
if (!user) {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  user = created.data.user;
} else {
  const updated = await admin.auth.admin.updateUserById(user.id, { password });
  if (updated.error) throw updated.error;
}
const cookies = new Map();
const session = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  cookies: {
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
    setAll: (values) => {
      for (const { name, value } of values) cookies.set(name, value);
    },
  },
});
const login = await session.auth.signInWithPassword({ email, password });
if (login.error) throw login.error;
const cookie = [...cookies].map(([name, value]) => name + '=' + value).join('; ');
function check(name, condition) {
  assert.ok(condition, name);
  console.log('PASS ' + name);
}
const apiKey = 'sk_live_' + randomBytes(32).toString('hex');
let apiKeyId;
let previousDefaults;
try {
  await db.unsafe("UPDATE profiles SET role='admin', status='active' WHERE id=$1", [user.id]);
  await db.unsafe("UPDATE entitlements SET plan_key='pro',status='active' WHERE user_id=$1", [
    user.id,
  ]);
  await db.unsafe(
    "INSERT INTO ledger(user_id,request_id,kind,credits) VALUES ($1,$2,'grant',100000)",
    [user.id, 'proof-grant-' + randomUUID()],
  );
  const cred = await db.unsafe(
    "SELECT id FROM provider_credentials WHERE owner_id IS NULL AND provider='openai_compatible' AND base_url='http://localhost:11435/v1' AND status='active'",
  );
  if (!cred.length) {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      Buffer.from(process.env.ENCRYPTION_KEY, 'base64'),
      iv,
    );
    const ciphertext = Buffer.concat([cipher.update('local-stub', 'utf8'), cipher.final()]);
    await db.unsafe(
      "INSERT INTO provider_credentials(provider,base_url,ciphertext,iv,auth_tag,last_four) VALUES ('openai_compatible','http://localhost:11435/v1',$1,$2,$3,'stub')",
      [ciphertext, iv, cipher.getAuthTag()],
    );
  }
  await db.unsafe(
    "INSERT INTO sources(id,family,label,description,credit_multiplier) VALUES ('proof-preferred','gpt','Proof preferred','Local source at twice the multiplier',2),('proof-missing','gpt','Proof without coverage','Tests default fallback',3) ON CONFLICT(id) DO UPDATE SET status='active'",
  );
  // The local seed has one public model; set its source default for this proof.
  previousDefaults = await db.unsafe("SELECT id FROM sources WHERE family='gpt' AND is_default");
  await db.unsafe("UPDATE sources SET is_default=false WHERE family='gpt'");
  await db.unsafe("UPDATE sources SET is_default=true WHERE id='legacy-chat-stub'");
  await db.unsafe(
    "INSERT INTO channels(id,label,task,provider,base_url,model_id,public_model_id,source_id,input_per_mtok,output_per_mtok,cached_per_mtok) SELECT 'proof-preferred-channel','Proof preferred model',task,provider,base_url,model_id,public_model_id,'proof-preferred',input_per_mtok,output_per_mtok,cached_per_mtok FROM channels WHERE id='chat-stub' ON CONFLICT(id) DO UPDATE SET status='active'",
  );
  apiKeyId = (
    await db.unsafe(
      "INSERT INTO api_keys(owner_id,name,key_hash,key_prefix,last_four,scopes) VALUES ($1,'routing-proof',$2,'sk_live_',$3,ARRAY['chat']) RETURNING id",
      [user.id, createHash('sha256').update(apiKey).digest('hex'), apiKey.slice(-4)],
    )
  )[0].id;
  for (const source of ['proof-preferred', 'proof-missing']) {
    const pref = await session
      .from('user_routing_preferences')
      .upsert({ user_id: user.id, family: 'gpt', source_id: source });
    if (pref.error) throw pref.error;
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'stub-chat', messages: [{ role: 'user', content: 'Hello' }] }),
    });
    const body = await response.json();
    check(source + ' API 200', response.status === 200);
    check(
      'public model only',
      body.model === 'stub-chat' && !JSON.stringify(body).includes('stub-fixture'),
    );
    const event = (
      await db.unsafe(
        'SELECT channel_id,credits_charged,cost_usd FROM usage_events WHERE request_id=$1',
        [body.id.replace('chatcmpl-', '')],
      )
    )[0];
    check(
      source + ' channel selected',
      event.channel_id === (source === 'proof-preferred' ? 'proof-preferred-channel' : 'chat-stub'),
    );
    check(
      source + ' actual multiplier billed',
      Number(event.credits_charged) ===
        Math.ceil(Number(event.cost_usd) * 10000 * (source === 'proof-preferred' ? 2 : 1)),
    );
  }
  const cron = await fetch(base + '/api/cron/probe-models', {
    headers: { authorization: 'Bearer ' + process.env.CRON_SECRET },
  });
  check('hourly cron 200', cron.ok);
  const cronBody = await cron.json();
  check('cron probes both model sources', cronBody.checked >= 2 && cronBody.failed === 0);
  const count = (
    await db.unsafe(
      "SELECT count(*)::int AS n FROM model_health_checks WHERE bucket_hour=date_trunc('hour',now())",
    )
  )[0].n;
  await fetch(base + '/api/cron/probe-models', {
    headers: { authorization: 'Bearer ' + process.env.CRON_SECRET },
  });
  check(
    'cron retry is idempotent',
    (
      await db.unsafe(
        "SELECT count(*)::int AS n FROM model_health_checks WHERE bucket_hour=date_trunc('hour',now())",
      )
    )[0].n === count,
  );
  const chat = await fetch(base + '/api/chat', {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'stub-chat', content: 'Hello from the dashboard proof' }),
  });
  check('session chat 200', chat.ok);
  const conversation = chat.headers.get('x-conversation-id');
  const frames = await chat.text();
  check(
    'chat streams SSE and completes',
    frames.includes('data: [DONE]') && frames.includes('"delta"') && !frames.includes('"error"'),
  );
  const messages = await session
    .from('chat_messages')
    .select('role,content')
    .eq('conversation_id', conversation);
  check(
    'chat persists both completed messages',
    messages.data?.length === 2 &&
      messages.data.some((m) => m.role === 'assistant' && m.content.length > 0),
  );
  const usage = await db.unsafe(
    "SELECT api_key_id FROM usage_events WHERE user_id=$1 AND api_key_id IS NULL AND status='ok'",
    [user.id],
  );
  check('session usage has null API key id', usage.length > 0);
  for (const path of [
    '/dashboard/routing',
    '/dashboard/usage?tab=details',
    '/dashboard/status',
    '/dashboard/chat',
    '/admin/sources',
    '/admin/channels',
    '/prices',
  ]) {
    const response = await fetch(base + path, { headers: { cookie } });
    const html = await response.text();
    check(path + ' renders', response.ok && !html.includes('NEXT_HTTP_ERROR_FALLBACK;500'));
    if (path === '/dashboard/status')
      check(
        'current hour is populated',
        html.includes('Operational') && html.includes('Observed SLA'),
      );
    if (path === '/prices')
      check('prices exclude upstream model id', !html.includes('stub-fixture'));
  }
  console.log(
    'Local integration proof complete. Dedicated proof data retained for browser inspection.',
  );
} finally {
  // Restore even after an assertion fails; a proof must not change routing defaults.
  if (previousDefaults) {
    await db.begin(async (tx) => {
      await tx.unsafe("UPDATE sources SET is_default=false WHERE family='gpt'");
      for (const row of previousDefaults)
        await tx.unsafe('UPDATE sources SET is_default=true WHERE id=$1', [row.id]);
    });
  }
  if (apiKeyId)
    await db.unsafe("UPDATE api_keys SET status='revoked',revoked_at=now() WHERE id=$1", [
      apiKeyId,
    ]);
  await db.end();
}
