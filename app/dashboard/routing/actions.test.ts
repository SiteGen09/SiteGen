import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveDefaultProviderAction, saveRoutingAction } from './actions';

const state = vi.hoisted(() => ({
  filters: [] as Array<[string, unknown]>, tables: [] as string[],
  deleted: vi.fn(), upsert: vi.fn(), invalidated: vi.fn(), error: null as unknown,
}));
vi.mock('next/cache', () => ({ revalidatePath: state.invalidated }));
vi.mock('@/lib/dashboard/session', () => ({ requireUser: async () => ({ id: 'signed-in-user' }) }));
vi.mock('@/lib/chat/pipeline', () => ({ loadPlan: async () => ({ key: 'free' }) }));
vi.mock('@/lib/ai/sources', async (original) => ({
  ...await original<typeof import('@/lib/ai/sources')>(),
  listSources: async () => [
    { id: 'relay-gpt-chat', label: 'Relay.fast', family: 'gpt', modality: 'chat', status: 'active', min_plan: 'free' },
    { id: 'kie-gpt-chat', label: 'kie.ai gpt chat', family: 'gpt', modality: 'chat', status: 'active', min_plan: 'pro' },
  ],
}));
vi.mock('@/lib/ai/routing-provider-names', () => ({ loadRoutingProviderNames: async () => new Map() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: () => ({ upsert: state.upsert }) }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  from: (name: string) => {
    state.tables.push(name);
    const query = {
      upsert: (...args: unknown[]) => state.upsert(...args),
      delete: () => { state.deleted(); return query; },
      eq: (key: string, value: unknown) => { state.filters.push([key, value]); return query; },
      then: (fn: (value: unknown) => unknown) => Promise.resolve({ error: state.error }).then(fn),
    };
    return query;
  },
}) }));

function form(sourceId = '', modality = 'chat') {
  const data = new FormData();
  data.set('family', 'gpt'); data.set('modality', modality); data.set('sourceId', sourceId);
  data.set('user_id', 'forged-user');
  return data;
}
beforeEach(() => { vi.clearAllMocks(); state.filters = []; state.tables = []; state.error = null; state.upsert.mockResolvedValue({ error: null }); });

describe('saving routing preferences', () => {
  it('Auto clears only the authenticated user and requested family/modality', async () => {
    expect(await saveRoutingAction('', form('', 'image'))).toBe('Automatic routing enabled.');
    expect(state.filters).toEqual([['user_id', 'signed-in-user'], ['family', 'gpt'], ['modality', 'image']]);
    expect(state.deleted).toHaveBeenCalledTimes(1);
    expect(state.upsert).not.toHaveBeenCalled();
    expect(state.invalidated).toHaveBeenCalledWith('/dashboard/routing');
    expect(state.invalidated).toHaveBeenCalledWith('/dashboard/chat');
  });
  it('does not report success when clearing the preference fails', async () => {
    state.error = { message: 'unavailable' };
    expect(await saveRoutingAction('', form())).toContain('Could not enable');
    expect(state.invalidated).not.toHaveBeenCalled();
  });
  it('rejects a chat source submitted for image routing', async () => {
    expect(await saveRoutingAction('', form('relay-gpt-chat', 'image'))).toContain('unavailable');
    expect(state.upsert).not.toHaveBeenCalled();
  });
  it('saves a valid provider choice under the authenticated account', async () => {
    expect(await saveRoutingAction('', form('relay-gpt-chat'))).toBe('Routing preference saved.');
    expect(state.upsert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'signed-in-user', source_id: 'relay-gpt-chat', family: 'gpt', modality: 'chat' }), { onConflict: 'user_id,family,modality' });
  });
});

function providerForm(providerId: string) {
  const data = new FormData();
  data.set('providerId', providerId);
  data.set('user_id', 'forged-user');
  return data;
}

describe('saving the default provider', () => {
  it('stores the internal provider for a public id the plan can reach', async () => {
    expect(await saveDefaultProviderAction('', providerForm('provider-a'))).toBe('Default provider saved.');
    expect(state.tables).toEqual(['user_routing_provider']);
    expect(state.upsert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'signed-in-user', provider_id: 'relay.fast' }), { onConflict: 'user_id' });
  });
  it('refuses a provider whose only sources are above the plan, and unknown ids', async () => {
    expect(await saveDefaultProviderAction('', providerForm('provider-b'))).toContain('unavailable');
    expect(await saveDefaultProviderAction('', providerForm('relay.fast'))).toContain('unavailable');
    expect(state.upsert).not.toHaveBeenCalled();
  });
  it('Auto clears only the signed-in user', async () => {
    expect(await saveDefaultProviderAction('', providerForm(''))).toContain('platform default');
    expect(state.tables).toEqual(['user_routing_provider']);
    expect(state.filters).toEqual([['user_id', 'signed-in-user']]);
    expect(state.deleted).toHaveBeenCalledTimes(1);
  });
});
