/**
 * Compares what Relay billed with what the platform recorded and charged, per
 * model, over the most recent Relay usage log pages. Read-only.
 *
 *   pnpm exec tsx scripts/reconcile-relay-costs.mts [--pages 5]
 *
 * Requests are matched on model, prompt tokens (Relay counts cache reads as
 * prompt), completion tokens and a time window. A cost ratio away from 1.00
 * means stored Relay rates no longer match billing: check the source sync.
 */
import { config } from 'dotenv';
import postgres from 'postgres';
import { z } from 'zod';
import { RELAY_BASE_URL } from '../lib/ai/relay-catalog';
import { USD_PER_CREDIT } from '../lib/ai/pricing';
config({ path: '.env.local', quiet: true });

/** new-api's quota units per US dollar. */
const QUOTA_PER_USD = 500_000;
const MATCH_WINDOW_SECONDS = 180;

const token = process.env.RELAY_ACCESS_TOKEN;
const userId = process.env.RELAY_USER_ID;
if (!token || !userId) throw new Error('RELAY_ACCESS_TOKEN and RELAY_USER_ID are required');
const pagesArg = process.argv.indexOf('--pages');
const pages = pagesArg === -1 ? 3 : Number(process.argv[pagesArg + 1]);

const itemSchema = z.object({
  created_at: z.number(), model_name: z.string(), prompt_tokens: z.number(),
  completion_tokens: z.number(), quota: z.number(), other: z.string().optional().default(''),
});
const items: z.infer<typeof itemSchema>[] = [];
for (let page = 1; page <= pages; page++) {
  const response = await fetch(`${new URL(RELAY_BASE_URL).origin}/api/log/self?p=${page}&page_size=100&type=2`, {
    headers: { authorization: `Bearer ${token}`, 'New-Api-User': userId },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Relay log HTTP ${response.status}`);
  const body = z.object({ data: z.object({ items: z.array(itemSchema) }) }).parse(await response.json());
  items.push(...body.data.items);
  if (body.data.items.length < 100) break;
}
if (!items.length) {
  console.log('No Relay usage in the log.');
  process.exit(0);
}

const sql = postgres(process.env.DATABASE_URL!, { max: 1, connection: { default_transaction_read_only: true } });
try {
  const oldest = new Date((Math.min(...items.map((i) => i.created_at)) - MATCH_WINDOW_SECONDS) * 1000);
  const events = await sql<{ request_id: string; model_id: string; created_at: Date; input_tokens: number; output_tokens: number; cached_tokens: number; cost_usd: string | null; credits_charged: string | null }[]>`
    SELECT e.request_id, c.model_id, e.created_at, e.input_tokens, e.output_tokens, e.cached_tokens, e.cost_usd, e.credits_charged
    FROM usage_events e JOIN channels c ON c.id = e.channel_id
    WHERE c.base_url = ${RELAY_BASE_URL} AND e.status = 'ok' AND e.created_at >= ${oldest}`;
  const used = new Set<string>();
  const totals = new Map<string, { matched: number; unmatched: number; relayUsd: number; costUsd: number; chargedUsd: number; tiers: Set<string> }>();
  for (const item of items) {
    const total = totals.get(item.model_name) ?? { matched: 0, unmatched: 0, relayUsd: 0, costUsd: 0, chargedUsd: 0, tiers: new Set<string>() };
    totals.set(item.model_name, total);
    try {
      const tier = (JSON.parse(item.other || '{}') as { routing_tier?: string }).routing_tier;
      if (tier) total.tiers.add(tier);
    } catch { /* tier is informational */ }
    const event = events.find((candidate) =>
      !used.has(candidate.request_id) &&
      candidate.model_id === item.model_name &&
      candidate.input_tokens + candidate.cached_tokens === item.prompt_tokens &&
      candidate.output_tokens === item.completion_tokens &&
      Math.abs(candidate.created_at.getTime() / 1000 - item.created_at) <= MATCH_WINDOW_SECONDS);
    if (!event) {
      total.unmatched += 1;
      continue;
    }
    used.add(event.request_id);
    total.matched += 1;
    total.relayUsd += item.quota / QUOTA_PER_USD;
    total.costUsd += Number(event.cost_usd ?? 0);
    total.chargedUsd += Number(event.credits_charged ?? 0) * USD_PER_CREDIT;
  }
  console.table([...totals].map(([model, t]) => ({
    model, sources: [...t.tiers].join(','), matched: t.matched, unmatched: t.unmatched,
    relayUsd: t.relayUsd.toFixed(6), recordedCostUsd: t.costUsd.toFixed(6), chargedUsd: t.chargedUsd.toFixed(6),
    costRatio: t.relayUsd ? (t.costUsd / t.relayUsd).toFixed(2) : '-',
    margin: t.chargedUsd ? `${(((t.chargedUsd - t.relayUsd) / t.chargedUsd) * 100).toFixed(0)}%` : '-',
  })));
  console.log('Unmatched rows are Relay requests made outside this platform (other keys, the Relay dashboard) or not yet recorded.');
} finally {
  await sql.end();
}
