import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { sql } from '@/lib/db';
import { createSourceAction, updateSourceAction } from '@/app/admin/sources/actions';
import { createChannelAction, updateChannelAction } from '@/app/admin/channels/actions';
import { selectChannelByModel } from '@/lib/ai/channels';
import { loadRoutingPreferences } from '@/lib/ai/sources';

// Keep real transactions and audit writes: a mock database cannot prove rollback.
const auth = vi.hoisted(() => ({ actorId: '', failAudit: false }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/api/admin', async (original) => {
  const actual = await original<typeof import('@/lib/api/admin')>();
  return {
    ...actual,
    requireAdmin: async () => ({ user: { id: auth.actorId } }),
    writeAudit: async (...args: Parameters<typeof actual.writeAudit>) => {
      if (auth.failAudit) throw new Error('Simulated audit outage');
      return actual.writeAudit(...args);
    },
  };
});
const suffix = crypto.randomUUID();
const sourceId = 'admin-proof-' + suffix;
const channelId = 'admin-channel-' + suffix;
const requestId = 'snapshot-' + suffix;
const routeSourceId = 'unique-source-' + suffix;
const otherSourceId = 'other-source-' + suffix;
const routeId = 'unique-route-' + suffix;
const duplicateId = 'duplicate-route-' + suffix;
const otherRouteId = 'other-route-' + suffix;
const publicModel = 'shared-' + suffix;
const createdSourceIds = [sourceId, routeSourceId, otherSourceId];
const createdChannelIds = [channelId, routeId, duplicateId, otherRouteId];
const password = crypto.randomUUID();
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const session = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } },
);

beforeAll(async () => {
  const created = await admin.auth.admin.createUser({
    email: suffix + '@test.local',
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) throw new Error('Could not create test actor');
  auth.actorId = created.data.user.id;
  const signedIn = await session.auth.signInWithPassword({
    email: suffix + '@test.local',
    password,
  });
  if (signedIn.error) throw signedIn.error;
  await sql`INSERT INTO sources (id,family,label,credit_multiplier) VALUES (${sourceId},'gpt','Original source',1)`;
  await sql`INSERT INTO channels (id,label,task,provider,model_id,source_id,input_per_mtok,output_per_mtok,cached_per_mtok) VALUES (${channelId},'Test','chat.completions','openai_compatible','test',${sourceId},1,1,0)`;
  await sql`INSERT INTO sources (id,family,label,credit_multiplier) VALUES
    (${routeSourceId},'gpt','Unique route source',1), (${otherSourceId},'gpt','Other route source',1)`;
  await sql`INSERT INTO channels (id,label,task,provider,model_id,source_id,public_model_id,input_per_mtok,output_per_mtok,cached_per_mtok)
    VALUES (${routeId},'Original route','chat.completions','openai_compatible','test',${routeSourceId},${publicModel},1,1,0)`;
}, 30000);

afterAll(async () => {
  await sql`DELETE FROM usage_events WHERE request_id=${requestId}`;
  await sql`DELETE FROM admin_audit_log WHERE actor_id=${auth.actorId}`;
  await sql`DELETE FROM user_routing_preferences WHERE user_id=${auth.actorId}`;
  await sql`DELETE FROM channels WHERE id IN ${sql(createdChannelIds)}`;
  await sql`DELETE FROM sources WHERE id IN ${sql(createdSourceIds)}`;
  if (auth.actorId) await admin.auth.admin.deleteUser(auth.actorId);
  await sql.end();
});

function form(overrides: Partial<Record<string, string>> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    id: sourceId,
    family: 'gpt',
    label: 'Original source',
    description: '',
    creditMultiplier: '2',
    status: 'active',
    minPlan: 'free',
    confirmReprice: 'on',
    affectedCount: '1',
    originalMultiplier: '1',
    ...overrides,
  }))
    if (value !== undefined) data.set(key, value);
  return data;
}
const idle = { status: 'idle' } as const;

function channelForm(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    id: duplicateId,
    label: 'Channel proof',
    task: 'chat.completions',
    provider: 'openai_compatible',
    baseUrl: 'http://localhost:11435/v1',
    modelId: 'private-model',
    publicModelId: publicModel,
    sourceId: routeSourceId,
    status: 'active',
    minPlan: 'free',
    priority: '0',
    inputPerMTok: '1',
    outputPerMTok: '1',
    cachedPerMTok: '0',
    pricingType: 'token',
    ...overrides,
  }))
    data.set(key, value);
  return data;
}

describe('source repricing transaction', () => {
  it('rejects absent confirmation and stale price or channel count without an audit or mutation', async () => {
    for (const override of [
      { confirmReprice: '' },
      { originalMultiplier: '0.5' },
      { affectedCount: '0' },
    ]) {
      expect((await updateSourceAction(idle, form(override))).status).toBe('error');
    }
    expect(
      Number(
        (await sql`SELECT credit_multiplier FROM sources WHERE id=${sourceId}`)[0]
          ?.credit_multiplier,
      ),
    ).toBe(1);
    expect(await sql`SELECT id FROM admin_audit_log WHERE actor_id=${auth.actorId}`).toHaveLength(
      0,
    );
  });

  it('rolls back a price change if its audit cannot be written', async () => {
    auth.failAudit = true;
    try {
      expect((await updateSourceAction(idle, form())).status).toBe('error');
    } finally {
      auth.failAudit = false;
    }
    expect(
      Number(
        (await sql`SELECT credit_multiplier FROM sources WHERE id=${sourceId}`)[0]
          ?.credit_multiplier,
      ),
    ).toBe(1);
  });

  it('commits a confirmed change with its before/after audit', async () => {
    expect((await updateSourceAction(idle, form())).status).toBe('success');
    const audit = (
      await sql`SELECT before, after FROM admin_audit_log WHERE actor_id=${auth.actorId}`
    )[0];
    expect(Number(audit?.before.credit_multiplier)).toBe(1);
    expect(Number(audit?.after.credit_multiplier)).toBe(2);
  });

  it('keeps a usage source snapshot across source edits and idempotent retries', async () => {
    await sql`INSERT INTO usage_events (request_id,user_id,channel_id,status) VALUES (${requestId},${auth.actorId},${channelId},'ok')`;
    expect(
      (await updateSourceAction(idle, form({ creditMultiplier: '2', label: 'Renamed source' })))
        .status,
    ).toBe('success');
    await sql`INSERT INTO usage_events (request_id,user_id,channel_id,status) VALUES (${requestId},${auth.actorId},${channelId},'ok') ON CONFLICT (request_id) DO UPDATE SET status=EXCLUDED.status`;
    const event = (
      await sql`SELECT source_id,source_label FROM usage_events WHERE request_id=${requestId}`
    )[0];
    expect(event?.source_id).toBe(sourceId);
    expect(event?.source_label).toBe('Original source');
  });
});

describe('one public model per source', () => {
  it('rejects a duplicate in PostgreSQL even when the write bypasses admin validation', async () => {
    await expect(sql`
      INSERT INTO channels (id,label,task,provider,model_id,source_id,public_model_id,input_per_mtok,output_per_mtok,cached_per_mtok)
      VALUES (${duplicateId},'Duplicate','chat.completions','openai_compatible','private-model',${routeSourceId},${publicModel},1,1,0)
    `).rejects.toMatchObject({
      code: '23505',
      constraint_name: 'channels_source_public_model_key',
    });
  });

  it('returns a readable duplicate-create error and writes neither a channel nor an audit', async () => {
    const result = await createChannelAction(idle, channelForm());
    expect(result).toEqual({
      status: 'error',
      message: `public model '${publicModel}' is already assigned to channel '${routeId}' on source '${routeSourceId}'`,
    });
    expect(await sql`SELECT id FROM channels WHERE id=${duplicateId}`).toHaveLength(0);
    expect(
      await sql`SELECT id FROM admin_audit_log WHERE target=${'channel:' + duplicateId}`,
    ).toHaveLength(0);
  });

  it('allows the same name on another source and permits an unchanged edit', async () => {
    const input = channelForm({ id: otherRouteId, sourceId: otherSourceId });
    expect((await createChannelAction(idle, input)).status).toBe('success');
    expect((await updateChannelAction(idle, input)).status).toBe('success');
    expect(
      await sql`SELECT id FROM admin_audit_log WHERE target=${'channel:' + otherRouteId}`,
    ).toHaveLength(2);
  });

  it('rejects reassigning a model onto a source that already serves it, without altering its audit', async () => {
    const result = await updateChannelAction(idle, channelForm({ id: otherRouteId }));
    expect(result).toEqual({
      status: 'error',
      message: `public model '${publicModel}' is already assigned to channel '${routeId}' on source '${routeSourceId}'`,
    });
    expect((await sql`SELECT source_id FROM channels WHERE id=${otherRouteId}`)[0]?.source_id).toBe(
      otherSourceId,
    );
    expect(
      await sql`SELECT id FROM admin_audit_log WHERE target=${'channel:' + otherRouteId}`,
    ).toHaveLength(2);
  });

  it('allows multiple internal channels with no public name on a source', async () => {
    for (const number of [1, 2]) {
      const id = 'unnamed-' + number + '-' + suffix;
      createdChannelIds.push(id);
      expect((await createChannelAction(idle, channelForm({ id, publicModelId: '' }))).status).toBe(
        'success',
      );
    }
  });

  it('keeps BYOK channels with no source outside the uniqueness guard', async () => {
    for (const number of [1, 2]) {
      const id = 'byok-' + number + '-' + suffix;
      createdChannelIds.push(id);
      expect(
        (await createChannelAction(idle, channelForm({ id, sourceId: '', isByok: 'on' }))).status,
      ).toBe('success');
    }
  });
});

describe('additional routing families', () => {
  it.each(['deepseek', 'qwen'])(
    'creates and selects a %s source through the existing actions and routing pipeline',
    async (family) => {
      const id = family + '-' + suffix;
      const model = family + '-model-' + suffix;
      createdSourceIds.push(id);
      createdChannelIds.push(id);
      expect(
        (await createSourceAction(idle, form({ id, family, creditMultiplier: '1' }))).status,
      ).toBe('success');
      expect(
        (await createChannelAction(idle, channelForm({ id, sourceId: id, publicModelId: model })))
          .status,
      ).toBe('success');
      const preference = await session
        .from('user_routing_preferences')
        .upsert({ user_id: auth.actorId, family, source_id: id });
      expect(preference.error).toBeNull();
      const preferences = await loadRoutingPreferences(auth.actorId);
      expect((await selectChannelByModel(model, 'free', preferences))?.id).toBe(id);
      expect(
        await sql`SELECT id FROM admin_audit_log WHERE target IN (${'source:' + id}, ${'channel:' + id})`,
      ).toHaveLength(2);
    },
  );
});
