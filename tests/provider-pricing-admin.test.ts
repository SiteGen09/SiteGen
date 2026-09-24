import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/db';
import { listProviderPricing } from '@/lib/admin/provider-pricing';
import { releaseProviderPricingAction, saveProviderAction } from '@/app/admin/providers/actions';
import { updateSourceAction } from '@/app/admin/sources/actions';

// Writes committed rows, so it only ever runs against the local database.
const databaseUrl = process.env.DATABASE_URL;
const local = !!databaseUrl && ['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname);

const auth = vi.hoisted(() => ({ actorId: '' }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/api/admin', async (original) => {
  const actual = await original<typeof import('@/lib/api/admin')>();
  return { ...actual, requireAdmin: async () => ({ user: { id: auth.actorId } }) };
});

const suffix = randomUUID();
// A unique endpoint host is its own provider, so no real provider is touched.
const host = `api.${suffix}.example`;
const cheap = 'ptest-cheap-' + suffix;
const dear = 'ptest-dear-' + suffix;
const late = 'ptest-late-' + suffix;
const sourceIds = [cheap, dear, late];
const idle = { status: 'idle' } as const;

async function multipliers(): Promise<Record<string, number>> {
  const rows = await sql`SELECT id, credit_multiplier FROM sources WHERE id IN ${sql(sourceIds)}`;
  return Object.fromEntries(rows.map((row) => [row.id, Number(row.credit_multiplier)]));
}

async function provider() {
  const [found] = await listProviderPricing(sql, host);
  if (!found) throw new Error('test provider not found');
  return found;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({ id: host, label: '', creditMultiplier: '', fingerprint: '', ...fields }))
    data.set(key, value);
  return data;
}

async function addSource(id: string, multiplier: number): Promise<void> {
  await sql`INSERT INTO sources (id, family, modality, label, credit_multiplier)
    VALUES (${id}, 'gpt', 'chat', 'Test source', ${multiplier})`;
  await sql`INSERT INTO channels (id, label, task, provider, base_url, model_id, public_model_id, source_id, input_per_mtok, output_per_mtok, cached_per_mtok)
    VALUES (${id}, 'Test model', 'chat.completions', 'openai_compatible', ${'https://' + host + '/v1'}, 'private', ${id}, ${id}, 1, 1, 0)`;
}

describe.skipIf(!local)('provider pricing', () => {
  beforeAll(async () => {
    const actor = (await sql`SELECT id FROM profiles ORDER BY created_at LIMIT 1`)[0];
    if (!actor) throw new Error('local database has no profile to act as administrator');
    auth.actorId = actor.id;
    await addSource(cheap, 1.2);
    await addSource(dear, 1.5);
  }, 30000);

  afterAll(async () => {
    const targets = [...sourceIds.map((id) => 'source:' + id), 'routing_provider:' + host];
    await sql`DELETE FROM admin_audit_log WHERE target IN ${sql(targets)}`;
    await sql`DELETE FROM routing_price_history WHERE target IN ${sql(targets)}`;
    await sql`DELETE FROM channels WHERE id IN ${sql(sourceIds)}`;
    await sql`DELETE FROM sources WHERE id IN ${sql(sourceIds)}`;
    await sql`DELETE FROM routing_providers WHERE id = ${host}`;
    await sql.end();
  });

  it('groups every source served by the provider host', async () => {
    const found = await provider();
    expect(found).toMatchObject({
      sourceIds: [cheap, dear], minMultiplier: '1.20', maxMultiplier: '1.50',
      managedMultiplier: null, label: null, modelCount: 2, defaultLabel: host,
    });
  });

  it('renames without repricing and rejects a name another provider shows', async () => {
    expect(await saveProviderAction(idle, form({ label: '  Budget  ' }))).toEqual({ status: 'success', message: 'Saved.' });
    expect((await provider()).label).toBe('Budget');
    expect(await multipliers()).toEqual({ [cheap]: 1.2, [dear]: 1.5 });
    const taken = await saveProviderAction(idle, form({ label: 'provider a' }));
    expect(taken.status).toBe('error');
    expect((await provider()).label).toBe('Budget');
  });

  it('refuses an unconfirmed or stale reprice without changing any price', async () => {
    const { fingerprint } = await provider();
    expect((await saveProviderAction(idle, form({ label: 'Budget', creditMultiplier: '1.3', fingerprint }))).status).toBe('error');
    expect((await saveProviderAction(idle, form({ label: 'Budget', creditMultiplier: '1.3', fingerprint: 'stale', confirmReprice: 'on' }))).status).toBe('error');
    expect(await multipliers()).toEqual({ [cheap]: 1.2, [dear]: 1.5 });
    expect((await provider()).managedMultiplier).toBeNull();
  });

  it('reprices every source in one save, with audit and public price history', async () => {
    const { fingerprint } = await provider();
    const result = await saveProviderAction(idle, form({ label: 'Budget', creditMultiplier: '1.3', fingerprint, confirmReprice: 'on' }));
    expect(result).toEqual({ status: 'success', message: 'Saved. Repriced 2 sources.' });
    expect(await multipliers()).toEqual({ [cheap]: 1.3, [dear]: 1.3 });
    expect((await provider()).managedMultiplier).toBe('1.30');
    const audits = await sql`SELECT action, target FROM admin_audit_log
      WHERE target IN ${sql(['source:' + cheap, 'source:' + dear])} AND action = 'source.update'`;
    expect(audits).toHaveLength(2);
    const history = await sql`SELECT before, after FROM routing_price_history WHERE target = ${'source:' + dear}`;
    expect(history.at(-1)).toMatchObject({ before: { credit_multiplier: 1.5 }, after: { credit_multiplier: 1.3 } });
  });

  it('holds the price when an importer rewrites a source or adds a new one', async () => {
    // What scripts/import-kie-catalog.mts does with its hard-coded multiplier.
    await sql`INSERT INTO sources (id, family, modality, label, credit_multiplier)
      VALUES (${dear}, 'gpt', 'chat', 'Test source', 1.5)
      ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, credit_multiplier = EXCLUDED.credit_multiplier`;
    // A source with no naming convention joins the provider through its channel.
    await addSource(late, 1.5);
    expect(await multipliers()).toEqual({ [cheap]: 1.3, [dear]: 1.3, [late]: 1.3 });
    await sql`UPDATE sources SET credit_multiplier = 1.5 WHERE id = ${late}`;
    expect((await multipliers())[late]).toBe(1.3);
  });

  it('points a per-source edit of a managed provider back to provider pricing', async () => {
    const data = new FormData();
    for (const [key, value] of Object.entries({
      id: cheap, family: 'gpt', label: 'Test source', description: '', creditMultiplier: '2',
      status: 'active', minPlan: 'free', confirmReprice: 'on', affectedCount: '1', originalMultiplier: '1.3',
    })) data.set(key, value);
    const result = await updateSourceAction(idle, data);
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('Provider pricing');
    expect((await multipliers())[cheap]).toBe(1.3);
  });

  it('releases the provider-wide price and keeps the current prices', async () => {
    const saved = await saveProviderAction(idle, form({ label: 'Budget', creditMultiplier: '1.30', fingerprint: 'unchanged-needs-no-check' }));
    expect(saved).toEqual({ status: 'success', message: 'Saved.' });
    expect((await releaseProviderPricingAction(idle, form({}))).status).toBe('success');
    expect((await provider()).managedMultiplier).toBeNull();
    await sql`UPDATE sources SET credit_multiplier = 1.5 WHERE id = ${late}`;
    expect(await multipliers()).toEqual({ [cheap]: 1.3, [dear]: 1.3, [late]: 1.5 });
  });

  it('keeps provider settings out of client roles and resolves importer-named sources', async () => {
    const [grants] = await sql`SELECT
      has_table_privilege('authenticated', 'public.routing_providers', 'SELECT') AS user_read,
      has_table_privilege('anon', 'public.routing_providers', 'SELECT') AS anon_read,
      has_table_privilege('service_role', 'public.routing_providers', 'SELECT') AS service_read`;
    expect(grants).toMatchObject({ user_read: false, anon_read: false, service_read: true });
    const [names] = await sql`SELECT
      public.source_routing_provider('kie-new-chat', 'kie.ai new chat') AS kie,
      public.source_routing_provider('relay-new-chat', 'Relay.fast') AS relay,
      public.source_routing_provider(${cheap}, 'Test source') AS channel_host`;
    expect(names).toEqual({ kie: 'kie.ai', relay: 'relay.fast', channel_host: host });
  });
});
