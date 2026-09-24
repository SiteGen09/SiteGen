import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const local = databaseUrl && ['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname);

describe.skipIf(!local)('routing price history database', () => {
  it('records import and admin repricing atomically without exposing private metadata', async () => {
    const sql = postgres(databaseUrl!, { max: 1 });
    const rollback = new Error('rollback verification fixtures');
    const id = 'price-history-' + randomUUID();
    try {
      await expect(sql.begin(async (tx) => {
        const existing = await tx`SELECT to_regclass('public.routing_price_history') AS name`;
        if (!existing[0]?.name) {
          const migration = await readFile('supabase/migrations/20260921100000_routing_price_history.sql', 'utf8');
          await tx.unsafe(migration);
        }
        await tx`INSERT INTO sources (id, family, modality, label, description, credit_multiplier)
          VALUES (${id}, 'gpt', 'chat', 'relay.fast', 'Test', 1.5)`;
        await tx`INSERT INTO channels (id, label, task, provider, base_url, model_id, public_model_id, source_id, input_per_mtok, output_per_mtok, cached_per_mtok)
          VALUES (${id}, 'Test model', 'chat.completions', 'openai_compatible', 'https://relay.fast/v1', 'private-model', ${id}, ${id}, 1, 2, .1)`;
        await tx`UPDATE channels SET label = 'Renamed' WHERE id = ${id}`;
        expect(await tx`SELECT * FROM routing_price_history WHERE target = ${'channel:' + id}`).toHaveLength(0);
        await tx`UPDATE channels SET input_per_mtok = 2 WHERE id = ${id}`;
        await tx`UPDATE sources SET credit_multiplier = 2 WHERE id = ${id}`;
        const changes = await tx`SELECT * FROM routing_price_history WHERE target IN (${'channel:' + id}, ${'source:' + id}) ORDER BY id`;
        expect(changes).toHaveLength(2);
        expect(changes[0]?.before.input_per_mtok).toBe(1);
        expect(changes[0]?.after.input_per_mtok).toBe(2);
        expect(changes[1]?.before.credit_multiplier).toBe(1.5);
        expect(changes[1]?.after.credit_multiplier).toBe(2);
        expect(JSON.stringify(changes)).not.toContain('private-model');
        expect(JSON.stringify(changes)).not.toContain('base_url');

        const policy = { origin: 'relay.fast', version: 'one', syncedAt: '2026-09-20', tiers: [{ name: 'standard', rates: { inputPerMTok: 2, outputPerMTok: 2, cachedPerMTok: .1 } }] };
        await tx`UPDATE channels SET billing_policy = ${tx.json(policy)} WHERE id = ${id}`;
        const beforeSync = await tx`SELECT count(*)::int AS n FROM routing_price_history WHERE target = ${'channel:' + id}`;
        await tx`UPDATE channels SET billing_policy = ${tx.json({ ...policy, version: 'two', syncedAt: '2026-09-21' })} WHERE id = ${id}`;
        const afterSync = await tx`SELECT count(*)::int AS n FROM routing_price_history WHERE target = ${'channel:' + id}`;
        expect(afterSync[0]?.n).toBe(beforeSync[0]?.n);
        const privileges = await tx`SELECT
          has_table_privilege('authenticated', 'public.routing_price_history', 'SELECT') AS user_read,
          has_table_privilege('anon', 'public.routing_price_history', 'SELECT') AS anon_read,
          has_table_privilege('service_role', 'public.routing_price_history', 'SELECT') AS service_read`;
        expect(privileges[0]).toMatchObject({ user_read: false, anon_read: false, service_read: true });
        throw rollback;
      })).rejects.toBe(rollback);
    } finally { await sql.end(); }
  }, 30000);
});
