import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/lib/log';
import { MEDIA_POLICY_REQUIRED, MEDIA_REFUSAL, MEDIA_SAFETY_UNAVAILABLE, MEDIA_SUSPENDED } from './media-policy-text';

const state = vi.hoisted(() => ({
  profile: { media_policy_accepted_at: '2026-09-29T00:00:00Z' as string | null, media_suspended_at: null as string | null },
  rpc: vi.fn(),
  classify: vi.fn(),
  openAi: vi.fn(),
  strike: vi.fn(),
  uploads: [] as { path: string; contentType: string; bytes: Buffer }[],
  ownedTasks: [] as string[],
  jobInput: { prompt: 'a red fox' } as Record<string, unknown>,
}));

vi.mock('@/lib/guardrails/runtime', () => ({ recordPolicyViolation: state.strike }));
vi.mock('./openai-moderation', () => ({ openAiModerationRule: state.openAi }));
vi.mock('./media-classifier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./media-classifier')>()),
  classifyMedia: state.classify,
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    rpc: state.rpc,
    from: (table: string) => {
      const q = {
        select: () => q, eq: () => q, in: () => q, update: () => q, is: () => q,
        maybeSingle: async () => ({ data: table === 'profiles' ? state.profile : { input: state.jobInput }, error: null }),
        then: (fn: (value: unknown) => unknown) =>
          Promise.resolve({ data: state.ownedTasks.map((id) => ({ upstream_task_id: id })), error: null }).then(fn),
      };
      return q;
    },
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Buffer, options: { contentType: string }) => {
          state.uploads.push({ path, bytes, contentType: options.contentType });
          return { error: null };
        },
        createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.test/${path}?token=t` }, error: null }),
      }),
    },
  }),
}));

const { classifyAll, screenMediaOutput, screenMediaRequest } = await import('./media-gate');
const { SafetyUnavailableError } = await import('./media-classifier');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger;
const request = (input: Record<string, unknown>, extra: Partial<Parameters<typeof screenMediaRequest>[0]> = {}) =>
  screenMediaRequest({ userId: 'user-1', requestId: 'req-1', kind: 'image', input, log, ...extra });

async function pngDataUrl(): Promise<string> {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#3366ff' } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.profile = { media_policy_accepted_at: '2026-09-29T00:00:00Z', media_suspended_at: null };
  state.uploads = [];
  state.ownedTasks = [];
  state.rpc.mockResolvedValue({ data: { recorded: true, count: 1, suspended: false }, error: null });
  state.classify.mockResolvedValue({ verdict: 'allow', model: 'gemini-3.8-flash' });
  state.openAi.mockResolvedValue(null);
  state.strike.mockResolvedValue(undefined);
});

describe('account access', () => {
  it('requires the policy agreement before anything else', async () => {
    state.profile.media_policy_accepted_at = null;
    await expect(request({ prompt: 'a red fox' })).rejects.toMatchObject({ code: 'forbidden', message: MEDIA_POLICY_REQUIRED });
    expect(state.classify).not.toHaveBeenCalled();
  });

  it('refuses a suspended account', async () => {
    state.profile.media_suspended_at = '2026-09-29T00:00:00Z';
    await expect(request({ prompt: 'a red fox' })).rejects.toMatchObject({ code: 'forbidden', message: MEDIA_SUSPENDED });
  });
});

describe('screenMediaRequest', { timeout: 30_000 }, () => {
  it('passes a clean prompt through unchanged', async () => {
    const input = { prompt: 'a red fox in the snow' };
    await expect(request(input)).resolves.toBe(input);
    expect(state.classify).toHaveBeenCalledWith(expect.objectContaining({ stage: 'request', text: 'a red fox in the snow', images: [] }));
  });

  it('refuses on the word rules without asking the classifier, and logs digests only', async () => {
    await expect(request({ prompt: 'n.u.d.e woman' })).rejects.toMatchObject({ code: 'content_policy_violation', message: MEDIA_REFUSAL });
    expect(state.classify).not.toHaveBeenCalled();
    const args = state.rpc.mock.calls[0]![1];
    expect(args).toMatchObject({ p_user: 'user-1', p_request: 'req-1', p_stage: 'prompt', p_rule: 'adult_sexual', p_severe: false, p_decided_by: 'rules' });
    expect(args.p_prompt_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args)).not.toContain('woman');
    expect(state.strike).toHaveBeenCalledWith('media/adult_sexual', 'user-1', 'req-1');
  });

  it('marks a minors refusal severe', async () => {
    await expect(request({ prompt: 'loli anime' })).rejects.toThrow(MEDIA_REFUSAL);
    expect(state.rpc.mock.calls[0]![1]).toMatchObject({ p_rule: 'minors', p_severe: true });
  });

  it('screens every text field, not only the prompt', async () => {
    await expect(request({ prompt: 'a portrait', style: 'hentai' })).rejects.toThrow(MEDIA_REFUSAL);
  });

  it('refuses when the classifier blocks', async () => {
    state.classify.mockResolvedValue({ verdict: 'block', rule: 'impersonation', model: 'gemini-3.8-flash' });
    await expect(request({ prompt: 'the singer who performed Shake It Off, selfie' })).rejects.toThrow(MEDIA_REFUSAL);
    expect(state.rpc.mock.calls[0]![1]).toMatchObject({ p_rule: 'impersonation', p_decided_by: 'classifier:gemini-3.8-flash' });
  });

  it('fails closed without recording a violation when the classifier is down', async () => {
    state.classify.mockRejectedValue(new SafetyUnavailableError());
    await expect(request({ prompt: 'a red fox' })).rejects.toMatchObject({ code: 'channel_unavailable', status: 503, message: MEDIA_SAFETY_UNAVAILABLE });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('shows reference images to the classifier and gives the provider the checked copy', async () => {
    const input = { prompt: 'make it a watercolor', image_urls: [await pngDataUrl()] };
    const screened = await request(input);
    const sent = state.classify.mock.calls[0]![0];
    expect(sent.images).toHaveLength(1);
    expect(sent.images[0].mediaType).toBe('image/jpeg');
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0]!.path).toBe('user-1/references/req-1/0.jpg');
    expect(screened.image_urls).toEqual(['https://storage.test/user-1/references/req-1/0.jpg?token=t']);
  });

  it('never stores a reference that fails the check', async () => {
    state.classify.mockResolvedValue({ verdict: 'block', rule: 'ip', model: 'gemini-3.8-flash' });
    await expect(request({ prompt: 'put this on a shirt', image_url: await pngDataUrl() })).rejects.toThrow(MEDIA_REFUSAL);
    expect(state.uploads).toHaveLength(0);
    expect(state.rpc.mock.calls[0]![1]).toMatchObject({ p_stage: 'reference', p_reference_sha256: [expect.stringMatching(/^[0-9a-f]{64}$/)] });
  });

  it('rejects references that are not images or videos', async () => {
    const audio = `data:audio/mpeg;base64,${Buffer.from('ID3\x04\0\0\0\0\0\0\0\0', 'latin1').toString('base64')}`;
    await expect(request({ prompt: 'x', audio_url: audio })).rejects.toThrow(/only image and video/);
  });

  it('only extends tasks the user owns', async () => {
    await expect(request({ prompt: 'longer', taskId: 'someone-elses' })).rejects.toThrow(/not one of your finished generations/);
    state.ownedTasks = ['mine'];
    await expect(request({ prompt: 'longer', taskId: 'mine' })).resolves.toBeDefined();
  });

  it('keeps gensite-v1 to a prompt', async () => {
    await expect(request({ prompt: 'x', image_url: await pngDataUrl() }, { promptOnly: true })).rejects.toThrow(/prompt only/);
  });
});

describe('classifyAll', () => {
  it('lets OpenAI moderation add a refusal, and the most serious finding win', async () => {
    state.classify.mockResolvedValue({ verdict: 'block', rule: 'unspecified', model: 'gemini-3.8-flash' });
    state.openAi.mockResolvedValue('minors');
    await expect(classifyAll({ stage: 'request', kind: 'image', text: 'x', images: [], log })).resolves.toMatchObject({ verdict: 'block', rule: 'minors' });
  });

  it('blocks when only OpenAI moderation objects', async () => {
    state.openAi.mockResolvedValue('graphic_violence');
    await expect(classifyAll({ stage: 'request', kind: 'image', text: 'x', images: [], log })).resolves.toMatchObject({ verdict: 'block', rule: 'graphic_violence', model: 'openai-moderation' });
  });
});

describe('screenMediaOutput', { timeout: 30_000 }, () => {
  const job = { id: 'job-1', userId: 'user-1', requestId: 'req-1', kind: 'image' as const };
  const image = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();

  it('allows a clean result', async () => {
    await expect(screenMediaOutput(job, await image(), log)).resolves.toBe('allow');
    expect(state.classify).toHaveBeenCalledWith(expect.objectContaining({ stage: 'output', text: 'a red fox' }));
  });

  it('records a blocked result as an output violation', async () => {
    state.classify.mockResolvedValue({ verdict: 'block', rule: 'adult_sexual', model: 'gemini-3.8-flash' });
    await expect(screenMediaOutput(job, await image(), log)).resolves.toBe('block');
    expect(state.rpc.mock.calls[0]![1]).toMatchObject({ p_stage: 'output', p_job: 'job-1', p_rule: 'adult_sexual' });
  });

  it('reports bytes that are not an image as unreadable', async () => {
    await expect(screenMediaOutput(job, Buffer.from('not an image'), log)).resolves.toBe('unreadable');
    expect(state.classify).not.toHaveBeenCalled();
  });

  it('lets an outage surface so the job can be retried later', async () => {
    state.classify.mockRejectedValue(new SafetyUnavailableError());
    await expect(screenMediaOutput(job, await image(), log)).rejects.toBeInstanceOf(SafetyUnavailableError);
  });
});
