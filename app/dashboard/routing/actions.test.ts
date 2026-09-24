import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveRoutingAction } from './actions';

const state = vi.hoisted(() => ({
  filters: [] as Array<[string, unknown]>,
  deleted: vi.fn(), upsert: vi.fn(), invalidated: vi.fn(), error: null as unknown,
}));
vi.mock('next/cache', () => ({ revalidatePath: state.invalidated }));
vi.mock('@/lib/dashboard/session', () => ({ requireUser: async () => ({ id: 'signed-in-user' }) }));
vi.mock('@/lib/chat/pipeline', () => ({ loadPlan: async () => ({ key: 'free' }) }));
vi.mock('@/lib/ai/sources', async (original) => ({
  ...await original<typeof import('@/lib/ai/sources')>(),
  listSources: async () => [{ id: 'relay-gpt-chat', family: 'gpt', modality: 'chat', status: 'active', min_plan: 'free' }],
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: () => ({ upsert: state.upsert }) }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({
  from: (name: string) => {
    expect(name).toBe('user_routing_preferences');
    const query = {
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
beforeEach(() => { vi.clearAllMocks(); state.filters = []; state.error = null; state.upsert.mockResolvedValue({ error: null }); });

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
