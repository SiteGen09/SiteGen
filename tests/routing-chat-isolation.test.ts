import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const suffix = crypto.randomUUID();
const sourceId = 'isolation-' + suffix;
const lockedId = 'locked-' + suffix;
const users: string[] = [];
let a: SupabaseClient;
let b: SupabaseClient;
let conversationId: string;

beforeAll(async () => {
  const clients = [];
  for (const name of ['a', 'b']) {
    const email = name + '-' + suffix + '@test.local';
    const password = crypto.randomUUID();
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error('Could not create isolation user');
    users.push(created.data.user.id);
    const client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { persistSession: false },
    });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    clients.push(client);
  }
  a = clients[0]!;
  b = clients[1]!;
  const source = await admin.from('sources').insert([
    { id: sourceId, family: 'gpt', label: 'Test', credit_multiplier: 1, min_plan: 'free' },
    { id: lockedId, family: 'gpt', label: 'Locked', credit_multiplier: 2, min_plan: 'pro' },
  ]);
  if (source.error) throw source.error;
  const conversation = await admin
    .from('chat_conversations')
    .insert({ user_id: users[1], title: 'Private', model: 'public-name' })
    .select('id')
    .single();
  if (conversation.error) throw conversation.error;
  conversationId = conversation.data.id;
  const message = await admin
    .from('chat_messages')
    .insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: 'Private answer',
      model: 'public-name',
    });
  if (message.error) throw message.error;
}, 30000);

afterAll(async () => {
  for (const id of users) await admin.auth.admin.deleteUser(id);
  await admin.from('sources').delete().in('id', [sourceId, lockedId]);
});

describe('source and chat RLS', () => {
  it('allows own source preference while rejecting a different family and higher plan', async () => {
    const own = await a
      .from('user_routing_preferences')
      .upsert({ user_id: users[0], family: 'gpt', source_id: sourceId });
    expect(own.error).toBeNull();
    const family = await a
      .from('user_routing_preferences')
      .insert({ user_id: users[0], family: 'claude', source_id: sourceId });
    expect(family.error).not.toBeNull();
    const locked = await a
      .from('user_routing_preferences')
      .update({ source_id: lockedId })
      .eq('user_id', users[0]!);
    expect(locked.error).not.toBeNull();
  });
  it('rejects a preference written as another owner', async () => {
    expect(
      (
        await a
          .from('user_routing_preferences')
          .insert({ user_id: users[1], family: 'gpt', source_id: sourceId })
      ).error,
    ).not.toBeNull();
  });
  it('keeps conversations and messages private but readable by their owner', async () => {
    expect((await a.from('chat_conversations').select('*').eq('id', conversationId)).data).toEqual(
      [],
    );
    expect(
      (await a.from('chat_messages').select('*').eq('conversation_id', conversationId)).data,
    ).toEqual([]);
    expect(
      (await b.from('chat_messages').select('*').eq('conversation_id', conversationId)).data,
    ).toHaveLength(1);
  });
  it('prevents clients forging assistant messages or source prices', async () => {
    expect(
      (
        await b
          .from('chat_messages')
          .insert({
            conversation_id: conversationId,
            role: 'assistant',
            content: 'Forged',
            model: 'public-name',
          })
      ).error,
    ).not.toBeNull();
    await a.from('sources').update({ credit_multiplier: 0.01 }).eq('id', sourceId);
    expect(
      Number(
        (await admin.from('sources').select('credit_multiplier').eq('id', sourceId).single()).data
          ?.credit_multiplier,
      ),
    ).toBe(1);
  });
});
