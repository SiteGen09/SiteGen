/**
 * Determines which surface actually serves each imported kie.ai chat model.
 *
 * kie.ai's catalogue labels a model `taskType: ["Chat"]` without saying where
 * it is served, and the two chat surfaces do not agree: `gemini-3-pro` answers
 * on /v1/chat/completions while `gpt-6-astra` answers only on
 * /codex/v1/responses and returns 422 on the other. A catalogue row that names
 * the wrong surface is worse than a missing one — it advertises a model that
 * 502s on first use — so every row is probed and the ones that answer nowhere
 * are switched off rather than guessed at.
 *
 * Each probe is a one-token completion, costing a small fraction of a cent.
 *
 *   KIE_API_KEY=... npx tsx scripts/probe-kie-chat.mts [--apply]
 */
import { config } from 'dotenv';
config({ path: '.env.local', quiet: true });

import postgres from 'postgres';

const APPLY = process.argv.includes('--apply');
const apiKey = process.env.KIE_API_KEY;
if (apiKey === undefined || apiKey.length === 0) {
  console.error('KIE_API_KEY is required');
  process.exit(1);
}

const CHAT = { base: 'https://api.kie.ai/v1', provider: 'openai_compatible' } as const;
const RESPONSES = { base: 'https://api.kie.ai/codex/v1', provider: 'openai_responses' } as const;

const TIMEOUT_MS = 45_000;

async function post(url: string, body: unknown): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();

    // The /codex/v1/responses surface answers with SSE whether or not
    // streaming was asked for, so a JSON parse is not a valid readiness test
    // there — it would report every working model as broken.
    if (text.startsWith('event:') || text.includes('data: {"type": "response.')) {
      return { ok: true, detail: 'ok (sse)' };
    }

    // Elsewhere the envelope returns HTTP 200 for application errors, so the
    // body is the only reliable signal: a real completion has choices.
    const parsed = JSON.parse(text) as { code?: number; msg?: string };
    if (typeof parsed.code === 'number' && parsed.code !== 200) {
      return { ok: false, detail: `${parsed.code} ${parsed.msg ?? ''}`.trim() };
    }
    const hasResult = text.includes('"choices"') || text.includes('"output"');
    return hasResult ? { ok: true, detail: 'ok' } : { ok: false, detail: text.slice(0, 80) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : 'unknown error' };
  }
}

const probeChat = (model: string) =>
  post(`${CHAT.base}/chat/completions`, {
    model,
    messages: [{ role: 'user', content: 'ok' }],
    max_tokens: 4,
  });

const probeResponses = (model: string) =>
  post(`${RESPONSES.base}/responses`, {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'ok' }] }],
  });

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
// Matched on the source's modality rather than a fixed source id: sources are
// split per family AND modality, so there is no single "the chat source".
const rows = await sql<{ id: string; public_model_id: string }[]>`
  SELECT c.id, c.public_model_id
  FROM channels c
  JOIN sources s ON s.id = c.source_id
  WHERE c.task = 'chat.completions' AND s.modality = 'chat' AND c.source_id LIKE 'kie-%'
  ORDER BY c.public_model_id`;

console.log(`probing ${rows.length} chat models across both surfaces\n`);

const results: { id: string; model: string; surface: 'chat' | 'responses' | null; detail: string }[] =
  [];

for (const row of rows) {
  const chat = await probeChat(row.public_model_id);
  if (chat.ok) {
    results.push({ id: row.id, model: row.public_model_id, surface: 'chat', detail: 'ok' });
    console.log(`  ${row.public_model_id.padEnd(34)} chat/completions`);
    continue;
  }
  const responses = await probeResponses(row.public_model_id);
  if (responses.ok) {
    results.push({ id: row.id, model: row.public_model_id, surface: 'responses', detail: 'ok' });
    console.log(`  ${row.public_model_id.padEnd(34)} responses`);
    continue;
  }
  results.push({
    id: row.id,
    model: row.public_model_id,
    surface: null,
    detail: `${chat.detail} | ${responses.detail}`.slice(0, 100),
  });
  console.log(`  ${row.public_model_id.padEnd(34)} NEITHER — ${chat.detail.slice(0, 50)}`);
}

const counts = {
  chat: results.filter((r) => r.surface === 'chat').length,
  responses: results.filter((r) => r.surface === 'responses').length,
  none: results.filter((r) => r.surface === null).length,
};
console.log(`\nchat/completions: ${counts.chat}  responses: ${counts.responses}  neither: ${counts.none}`);

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to update channels.');
  await sql.end();
  process.exit(0);
}

for (const result of results) {
  if (result.surface === null) {
    await sql`UPDATE channels SET status = 'off', updated_at = now() WHERE id = ${result.id}`;
    continue;
  }
  const surface = result.surface === 'chat' ? CHAT : RESPONSES;
  await sql`
    UPDATE channels
    SET provider = ${surface.provider}, base_url = ${surface.base},
        status = 'active', updated_at = now()
    WHERE id = ${result.id}`;
}
console.log(`\nupdated ${results.length} channels (${counts.none} switched off)`);
await sql.end();
